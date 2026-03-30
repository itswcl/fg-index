# PRD: Market Indicators — MVP Feature

> **Status:** Approved — Ready to Scaffold  
> **Author:** Technical PM (Antigravity)  
> **Stack:** Node.js (local) · React Native for macOS · Zod · TypeScript  
> **Monorepo root:** `/Users/weilee/Desktop/fg-index`

---

## 1. Feature Overview & Goals

Display two market sentiment signals — the **CNN Fear & Greed Index** and the **CBOE VIX** — in a premium macOS desktop widget. The two signals have different update frequencies: F&G is stable and fetched every 30 minutes; VIX is market-volatile and streamed in real-time where possible, with a 5-minute HTTP fallback. The macOS app renders both with color-coded sentiment.

| Signal               | Update Strategy                                            |
| -------------------- | ---------------------------------------------------------- |
| Fear & Greed         | HTTP fetch every **30 min** server-side; WS push to client |
| VIX                  | **Real-time WS** primary; **5-min HTTP poll** fallback     |
| VIX null-safe        | Shows **N/A** if both sources fail; stream stays alive     |
| Premium macOS        | Hover states, keyboard nav, staleness badge                |
| No hardcoded secrets | All upstream URLs in env vars                              |

---

## 2. Data Architecture

### 2.1 Upstream Sources

| Signal             | Source                       | Endpoint                                                          |
| ------------------ | ---------------------------- | ----------------------------------------------------------------- |
| Fear & Greed Index | CNN DataViz API              | `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/` |
| VIX                | Google Finance (HTML scrape) | `https://www.google.com/finance/quote/VIX:INDEXCBOE`              |
| VIX fallback       | Yahoo Finance                | `https://finance.yahoo.com/quote/%5EVIX/`                         |

**User-Agent (both requests):**  
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`

### 2.2 Zod Schemas — `packages/shared-types/src/index.ts`

```typescript
import { z } from "zod";

// ─── Fear & Greed ─────────────────────────────────────────────────
export const FearGreedClassificationSchema = z.enum([
  "Extreme Fear",
  "Fear",
  "Neutral",
  "Greed",
  "Extreme Greed",
]);

export const FearGreedSchema = z.object({
  score: z.number().min(0).max(100),
  classification: FearGreedClassificationSchema,
  previousClose: z.number().min(0).max(100),
  oneWeekAgo: z.number().min(0).max(100),
  oneMonthAgo: z.number().min(0).max(100),
  oneYearAgo: z.number().min(0).max(100),
  updatedAt: z.string().datetime(), // ISO 8601 from CNN
});

// ─── VIX ──────────────────────────────────────────────────────────
export const VixSchema = z.object({
  price: z.number().positive(),
  previousClose: z.number().positive(),
  change: z.number(),
  changePercent: z.number(),
  fetchedAt: z.string().datetime(), // ISO 8601, set by our server
});

// ─── Combined response ─────────────────────────────────────────────
export const MarketIndicatorsSchema = z.object({
  fearGreed: FearGreedSchema,
  vix: VixSchema,
});

// ─── Inferred TypeScript types ─────────────────────────────────────
export type FearGreedClassification = z.infer<
  typeof FearGreedClassificationSchema
>;
export type FearGreed = z.infer<typeof FearGreedSchema>;
export type Vix = z.infer<typeof VixSchema>;
export type MarketIndicators = z.infer<typeof MarketIndicatorsSchema>;
```

> **Rationale:** `previousClose` / `oneWeekAgo` / etc. from CNN give us instant trend arrows without a second API call. `fetchedAt` on VIX is server-stamped so the client can show staleness warnings.

---

## 3. API Spec — `apps/api-server`

### 3.1 Endpoints

Two independent endpoints — one per signal:

| Endpoint                  | Method | Purpose                        | Cache-Control           |
| ------------------------- | ------ | ------------------------------ | ----------------------- |
| `GET /api/fear-greed`     | GET    | Latest F&G snapshot            | `max-age=1800` (30 min) |
| `GET /api/vix`            | GET    | Latest VIX snapshot (fallback) | `max-age=300` (5 min)   |
| `ws://localhost:8081/vix` | WS     | Real-time VIX stream (primary) | N/A                     |

**Error shape (all endpoints):** `{ error: string, code: string }`

### 3.2 File Structure

```
apps/api-server/src/
├── index.ts                    # HTTP server entry point, CORS + security headers
├── ws.ts                       # WebSocket server entry point (VIX stream)
├── routes/
│   ├── fearGreed.ts            # GET /api/fear-greed controller
│   └── vix.ts                  # GET /api/vix controller (HTTP fallback)
├── services/
│   ├── cnn.ts                  # Fetch + Zod-parse CNN Fear & Greed
│   └── vix.ts                  # Scrape VIX: Google Finance → Yahoo fallback
├── schedulers/
│   ├── fearGreedScheduler.ts   # setInterval every 30 min, caches last result
│   └── vixScheduler.ts         # Real-time loop + 5-min poll fallback, broadcasts WS
├── errors/
│   └── httpError.ts            # Typed error utility — no console.log
└── config/
    └── env.ts                  # Validated env vars
```

### 3.3 Controller / Service / Scheduler Responsibilities

**`services/cnn.ts`** — Fetches CNN URL with `User-Agent` + `Accept: application/json`. Validates with internal `CnnRawSchema`, maps to `FearGreed`.

**`services/vix.ts`** — Fetches Google Finance HTML, extracts price via `/data-last-price="([^"]+)"/` and previous close via `/class="P6K39c"[^>]*>([0-9.]+)</`. Falls back to Yahoo Finance on non-200. Returns `Vix | null`.

**`schedulers/fearGreedScheduler.ts`**

- Fires every **30 min** via `setInterval`.
- Caches the last successful `FearGreed` result in memory.
- `routes/fearGreed.ts` serves the cache; no upstream call per HTTP request.

**`schedulers/vixScheduler.ts`** — Two-mode operation:

| Mode                          | Trigger                                | Behaviour                                                                                |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Real-time** (primary)       | Tight loop / `setInterval` every ~10 s | Fetches VIX, broadcasts `{ type: 'VIX_UPDATE', payload: Vix \| null }` to all WS clients |
| **HTTP fallback** (secondary) | `setInterval` every **5 min**          | Refreshes an in-memory VIX cache served by `GET /api/vix`                                |

> The real-time loop is throttled: if the upstream response time exceeds 8 s, the scheduler automatically widens the interval to 30 s until latency recovers. This prevents hammering Google/Yahoo during slowdowns.

**`routes/fearGreed.ts`** — Returns cached `FearGreed`. `Cache-Control: max-age=1800`.

**`routes/vix.ts`** — Returns cached `Vix | null`. `Cache-Control: max-age=300`.

**`errors/httpError.ts`** — `createHttpError(status, message, code)` → JSON error. No `console.log`.

### 3.4 Environment Variables

```
CNN_FEAR_GREED_URL=https://production.dataviz.cnn.io/index/fearandgreed/graphdata/
GOOGLE_FINANCE_VIX_URL=https://www.google.com/finance/quote/VIX:INDEXCBOE
YAHOO_FINANCE_VIX_URL=https://finance.yahoo.com/quote/%5EVIX/
SCRAPER_USER_AGENT=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
PORT=8080
WS_PORT=8081
FEAR_GREED_INTERVAL_MS=1800000   # 30 min
VIX_REALTIME_INTERVAL_MS=10000   # 10 s (real-time mode)
VIX_FALLBACK_INTERVAL_MS=300000  # 5 min (HTTP cache refresh)
```

> `.env.local` (gitignored). Local dev only.

### 3.5 Refresh & Transport Strategy

| Signal       | Server cadence              | Transport to client        | Client fallback                |
| ------------ | --------------------------- | -------------------------- | ------------------------------ |
| Fear & Greed | Every **30 min**            | WS push after each refresh | `GET /api/fear-greed` (cached) |
| VIX          | Every **~10 s** (real-time) | `ws://localhost:8081/vix`  | `GET /api/vix` every **5 min** |

**WS events:**

- `{ type: 'FEAR_GREED_UPDATE', payload: FearGreed }` — pushed after each 30-min refresh.
- `{ type: 'VIX_UPDATE', payload: Vix | null }` — pushed after each real-time fetch.

**VIX null handling:** Both Google Finance and Yahoo Finance fail → `payload: null` → client shows **N/A**; WS stream stays open.

---

## 4. UI/UX Strategy — `apps/macos-app`

### 4.1 Color-Coding Map

| Classification | Hex       | Semantic   |
| -------------- | --------- | ---------- |
| Extreme Fear   | `#C0392B` | Deep red   |
| Fear           | `#E74C3C` | Red        |
| Neutral        | `#F39C12` | Amber      |
| Greed          | `#27AE60` | Green      |
| Extreme Greed  | `#1E8449` | Deep green |

---

## 7. Decisions Log

| Question                | Decision                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| F&G update frequency    | **30 min** server-side refresh; WS push to client after each refresh      |
| VIX update strategy     | **Real-time WS** (~10 s loop) primary; **5-min HTTP poll** as fallback    |
| VIX real-time throttle  | Auto-widen to 30 s if upstream response > 8 s; recover when latency drops |
| VIX dual-source failure | **`null`** payload — macOS app shows **N/A**, WS stream stays alive       |
| GCF region              | **N/A** — local dev only for now                                          |
| API base URL            | `ws://localhost:8081` (VIX WS) + `http://localhost:8080` (HTTP endpoints) |
