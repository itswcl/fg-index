# Mobile Layout Spec — Line-Item Metric Rows

**Status:** Draft for UI/UX review
**Owner:** UI/UX session (design) → Frontend session (implementation)
**Related:** Feature 5 (Draggable Grid), PR #59 (4-column grid)

---

## Problem

On mobile (<640px), the current card grid renders one card per row at near full-screen width. Two issues:

1. **Wasted vertical space.** Each card is ~140px tall; only 2–3 metrics fit above the fold. Users can't glance at F&G + VIX + BTC + SPX + custom tickers without scrolling through a tall stack.
2. **Drag-to-reorder blocks native scroll.** `@dnd-kit` grabs the touch gesture, so users can't flick-scroll the page naturally — they either trigger an unwanted drag or have to aim carefully at negative space.

Reference screenshot: `fg-index-mobile-cards-fullwidth.png` (Slack thread 2026-04-16).

---

## Decision

Split the layout by breakpoint:

| Breakpoint | Layout | Reorder |
|---|---|---|
| **≥ 640px (desktop/tablet)** | Existing card grid (2–4 cols) | Drag-and-drop (unchanged) |
| **< 640px (mobile)** | **Line-item rows** (one metric per row, compact) | **Edit mode toggle** — drag handles appear only when user taps "Edit" |

Default mobile view is read-only and fully scrollable. Reorder is opt-in behind an edit toggle, so the 95% case (just checking numbers) has zero friction.

---

## Design Deliverables (UI/UX session)

### 1. Mobile Metric Row component

One reusable row used by F&G, VIX, BTC, SPX, and custom tickers.

**Required spec:**
- Height: target 44–56px (one-tap iOS HIG minimum)
- Layout: left-aligned label, right-aligned price cluster
- Label zone: metric name (e.g. `FEAR & GREED`, `BTC`, `AAPL`) + optional small sub-label (`Greed` for F&G)
- Price zone: main value + change + change% + direction arrow (↑/↓)
- Color: green/red for change, neutral for price
- Divider: hairline between rows (or card-like rounded container per row — design call)
- Tap target: entire row; tap behavior = TBD (expand inline? open detail sheet? no-op for v1?)

**States to design:**
- Default
- Loading (shimmer row — match existing `CardShimmer`)
- Error (muted text, "—" placeholder)
- Stale (when WS disconnected — match existing stale indicator)
- **Edit mode** (see below)

### 2. Mobile Header

Confirm icon order and collapsing behavior on narrow widths (320–420px). Current desktop header:

```
[ ticker input .......................... ] [+] [🔔] [☕] [●theme] [👤]
```

**Open questions for design:**
- Does the ticker input stay visible, or collapse to a search icon that expands on tap?
- Priority order when space is tight (e.g. 320px): which icons get hidden into a "⋯" overflow menu?
- Where does the new **Edit** toggle live? Proposals:
  - (a) New pencil icon in the header next to `+`
  - (b) Long-press any row to enter edit mode
  - (c) Sticky "Edit" text button at the very top-right

Recommendation from FE: **(a) pencil icon** — discoverable, matches iOS convention, keeps long-press free for future actions.

### 3. Edit Mode

When active:
- Drag handle (`≡` icon) appears on the left of each row
- Custom-ticker rows show a red `−` delete affordance on the right (default cards do not — they're permanent)
- Header toggle switches from pencil → "Done" text button
- Tapping "Done" exits edit mode and persists the new order
- Visual: dim the price zone slightly to signal "not interactive"

### 4. Breakpoint & Transitions

- Hard switch at `640px` (no fluid transition needed)
- Orientation change (portrait → landscape on phone) should re-evaluate breakpoint
- iPad portrait (~768px) stays on desktop grid

### 5. Empty States

- No custom tickers: show the add-ticker input + "Add your first ticker" hint under the 4 default rows
- Loading (cold start): 4 shimmer rows

---

## Non-Goals (v1)

- Tap-to-expand row detail (defer to v2)
- Sparklines in the row (defer — needs separate data fetch)
- Swipe-to-delete gestures (defer — edit mode is enough)
- Separate mobile app (this is still the web dashboard)

---

## FE Implementation Plan (post-design)

**Branch:** `feat/mobile-line-items`

| File | Change |
|---|---|
| `apps/web/src/hooks/useIsMobile.ts` | **New** — `useMediaQuery('(max-width: 639px)')` |
| `apps/web/src/components/MetricRow.tsx` | **New** — shared line-item row |
| `apps/web/src/components/MetricRow.css` | **New** — row styles, edit-mode variants |
| `apps/web/src/components/MobileMetricList.tsx` | **New** — renders all metrics as `<MetricRow />` list, handles edit mode + dnd gating |
| `apps/web/src/App.tsx` | Branch on `useIsMobile()` — render existing grid OR `<MobileMetricList />` |
| `apps/web/src/App.css` | Tighten `.widget` padding on mobile |
| `apps/web/src/components/Header.tsx` (or wherever top bar lives) | Add pencil/Done edit toggle (mobile only) |

**DnD behavior:**
- Desktop: `DndContext` always active (unchanged)
- Mobile: mount `DndContext` only when `editMode === true`; outside edit mode, rows are plain `<li>` elements so native scroll is unimpeded

**Persistence:** Edit-mode reorder writes to the same `useUnifiedOrder` hook as desktop — no new storage.

---

## Verification

1. `npx tsc --noEmit && npx vite build`
2. Chrome DevTools device emulation: iPhone SE (375px), iPhone 14 Pro (393px), iPad mini portrait (768px)
3. Real-device smoke test: flick-scroll the list, enter edit mode, reorder, exit, confirm order persists across reload and across browsers (cross-device sync requires the ticker-persistence backend work tracked in `/Users/weilee/.claude/plans/persist-tickers.md`)
4. Accessibility: rows are focusable, drag handles have `aria-label`, edit toggle has `aria-pressed`

---

## Open Questions for UI/UX

1. Row container style: flat dividers or individual rounded "mini-cards" per row?
2. Edit toggle placement — pencil icon (FE rec) or alternative?
3. Tap-row behavior in v1 — no-op, or open a details sheet?
4. How prominent should the change% be vs. the absolute price?
5. Does the header search input collapse on narrow screens, and if so at what width?

---

## UI/UX Decisions (resolved)

Design-session output — FE implements against these. No new tokens introduced; every
value resolves against existing `App.css` variables.

### Q1 — Row container style → Grouped list (single rounded card, hairline dividers)

Single container, iOS-Settings-style, rows share one surface divided by hairlines.

```
Container:
  background:    card-dark / card-light tokens
  border-radius: 20px
  shadow:        inherits card shadow
  padding:       0  (rows own their internal padding)

Divider between rows:
  height: 0.5px (1px on @1x)
  color:  rgba(255,255,255,0.08) dark / rgba(0,0,0,0.06) light
  inset:  16px from left (under label, not under drag handle)
  NOT rendered on the last row
```

### Q2 — Edit toggle → Pencil icon in header (confirms FE recommendation)

- Mobile-only pencil icon (20×20, stroke 1.5) as the rightmost slot in the top bar
- Tap target 44×44 (HIG minimum)
- Color `#8E8E93` idle → `#007AFF` while edit mode is active
- In edit mode the pencil swaps to a text `Done` button (17px semibold, `#007AFF`)
- Transition: `pencil → Done → pencil` (order persists on exit)

### Q3 — Tap-row behavior → No-op, tap-feedback only

No detail sheet, no inline expand. v1 rows are pure glanceable line items.

- On `pointerdown`: row tint `rgba(255,255,255,0.04)` dark / `rgba(0,0,0,0.04)` light for ~100ms
- On release: return to transparent
- Long-press reserved for future actions

### Q4 — Price vs change% hierarchy → Price primary, change% secondary

Right-aligned, stacked:

```
Row 1 (price):       17px semibold   primary text color
Row 2 (change %):    13px regular    color-coded with baked-in arrow
                     positive: #27AE60    format: "↑ 2.34%"
                     negative: #E74C3C    format: "↓ 1.12%"
                     neutral:  #8E8E93
Absolute change:     hidden on mobile (optional parens inline later)
```

Label zone (left-aligned, stacked):

```
Row 1 (name):      15px semibold   primary text
                   uppercase for the 4 defaults, as-typed for user tickers
Row 2 (sub-label): 12px regular    secondary text #8E8E93
                   F&G:  current classification ("Greed", "Fear", etc.)
                   VIX:  "Volatility"
                   BTC:  "Bitcoin"
                   SPX:  "S&P 500"
                   custom: `data.name` from API (hide if unavailable)
```

Row height: fixed **56px** (HIG 44pt + margin).

### Q5 — Header collapse → Ticker input collapses to search icon below 420px

Breakpoint: `< 420px`.

Collapsed idle: `[🔍] [+] [🔔] [☕] [●] [✏️]`

- Tap `🔍` → input slides in full-width, icons scroll off right, auto-focus
- Dismiss → ✕ button, or blur with empty input, or successful submit

Priority order (rightmost hides last): `🔍 + ✏️ ● ☕ 🔔` — status dot and edit
pencil must never be hidden.

### Edit-mode row visuals

```
Normal:
  [  FEAR & GREED              72     ]
  [  Greed                 ↑ 2.34%    ]

Edit mode (default card — no delete):
  [ ≡  FEAR & GREED           72      ]
  [    Greed              ↑ 2.34% (dim) ]

Edit mode (custom ticker — deletable):
  [ ≡  AAPL            [Cancel] [Delete] ]
  [    Apple Inc.                        ]
```

- Drag handle `≡`: inline SVG (three lines), 20×20, stroke 1.5, `#8E8E93`
- Press-and-hold on the handle area initiates drag (no delay — rows are already in edit mode)
- Delete UX (v1): inline `[Cancel] [Delete]` confirm replacing the price zone
  (simpler than swipe-to-reveal; ship first, iterate later)
- Price zone dims to opacity `0.4` in edit mode to signal it is not the interactive target

### Color / shadow / type tokens

No new tokens — all values resolve against existing `App.css`:
`card-dark`, `card-light`, `#8E8E93`, `#27AE60`, `#E74C3C`, `#007AFF`, `#FF3B30`.
