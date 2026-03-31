# Spec: User Notifications / Alerts

> **Status:** Draft
> **Author:** Technical PM
> **Stack:** Node.js · React Native for macOS · TypeScript · localStorage (Web) / AsyncStorage (macOS)
> **Related:** `docs/market-indicators-prd.md`

---

## 1. Feature Summary

Users can define custom threshold-based alerts — for example, "notify me when Fear & Greed drops below 10 AND VIX rises above 30" — that fire a browser/macOS push notification whenever the condition is met. Alerts are composed of one or more metric conditions joined by AND/OR logic, can be toggled on or off individually, and persist across page reloads via localStorage so no sign-in is required.

---

## 2. User Stories

1. **As a user**, I want to create a named alert with one or more conditions on Fear & Greed or VIX, so that I am automatically notified when the market reaches levels I care about.
2. **As a user**, I want to choose whether all conditions must be true (AND) or any one condition must be true (OR), so that I can express both conservative and permissive alert strategies.
3. **As a user**, I want to toggle an alert on or off without deleting it, so that I can temporarily silence it during periods when I am actively watching the dashboard.
4. **As a user**, I want to receive a native push notification with a plain-language message while the app is open, so that I do not have to stare at the screen waiting for a signal.
5. **As a user**, I want my alerts to survive a page reload or app restart, so that I do not need to recreate them every session.
6. **As a user**, I want to see when an alert last fired, so that I can assess how frequently market conditions are hitting my thresholds.
7. **As a user**, I want to delete alerts I no longer need, so that the alerts panel stays uncluttered.

---

## 3. Alert Data Model

### 3.1 TypeScript Interfaces

```typescript
interface Condition {
  metric: "fearGreed" | "vix"
  operator: "<" | ">" | "<=" | ">=" | "=="
  value: number
}

interface Alert {
  id: string           // UUID v4, generated client-side
  name: string         // User-defined label, e.g. "Extreme Fear + High VIX"
  conditions: Condition[]
  logic: "AND" | "OR"  // How conditions are combined
  enabled: boolean
  createdAt: string    // ISO 8601
  lastTriggeredAt?: string  // ISO 8601; absent if never triggered
}
```

### 3.2 JSON Schema (for validation / documentation)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "definitions": {
    "Condition": {
      "type": "object",
      "required": ["metric", "operator", "value"],
      "properties": {
        "metric":   { "type": "string", "enum": ["fearGreed", "vix"] },
        "operator": { "type": "string", "enum": ["<", ">", "<=", ">=", "=="] },
        "value":    { "type": "number" }
      },
      "additionalProperties": false
    },
    "Alert": {
      "type": "object",
      "required": ["id", "name", "conditions", "logic", "enabled", "createdAt"],
      "properties": {
        "id":               { "type": "string", "format": "uuid" },
        "name":             { "type": "string", "minLength": 1, "maxLength": 80 },
        "conditions": {
          "type": "array",
          "items": { "$ref": "#/definitions/Condition" },
          "minItems": 1
        },
        "logic":            { "type": "string", "enum": ["AND", "OR"] },
        "enabled":          { "type": "boolean" },
        "createdAt":        { "type": "string", "format": "date-time" },
        "lastTriggeredAt":  { "type": "string", "format": "date-time" }
      },
      "additionalProperties": false
    }
  }
}
```

### 3.3 Persistence

Alerts are stored under the key `fg_index_alerts` in **localStorage** (web) or **AsyncStorage** (React Native macOS). The value is a JSON-serialised `Alert[]` array. The client reads this array on startup and sends all enabled alerts to the server via the WebSocket handshake.

---

## 4. WebSocket Protocol Additions

The existing WS connection (`ws://localhost:8081`) is extended with two new message types. All existing message types (`FEAR_GREED_UPDATE`, `VIX_UPDATE`) are unchanged.

### 4.1 Client → Server: `set_alerts`

Sent by the client immediately after the WS connection is established and again whenever the user creates, edits, enables/disables, or deletes an alert.

```json
{
  "type": "set_alerts",
  "alerts": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Extreme Fear + High VIX",
      "conditions": [
        { "metric": "fearGreed", "operator": "<",  "value": 10 },
        { "metric": "vix",       "operator": ">",  "value": 30 }
      ],
      "logic": "AND",
      "enabled": true,
      "createdAt": "2026-03-31T12:00:00Z"
    }
  ]
}
```

The server replaces the session-scoped alert set for this connection. Only `enabled: true` alerts are evaluated.

### 4.2 Server → Client: `alert_triggered`

Sent by the server whenever a data update causes a registered alert's conditions to evaluate to `true`. Each triggered alert produces exactly one message per triggering data event (no repeated fires for the same data tick).

```json
{
  "type": "alert_triggered",
  "alertId":   "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "alertName": "Extreme Fear + High VIX",
  "message":   "Fear & Greed is 8 (< 10) AND VIX is 32.5 (> 30)"
}
```

The client:
1. Updates `lastTriggeredAt` on the matching `Alert` object in localStorage.
2. Fires a **Web Notifications API** / macOS local notification with `alertName` as the title and `message` as the body.

### 4.3 Server-side Evaluation Rules

- The server maintains a **per-connection** map of `alertId → Alert`.
- After each `FEAR_GREED_UPDATE` or `VIX_UPDATE` event, the server evaluates all enabled alerts for that connection against the latest cached `fearGreed.score` and `vix.price`.
- An alert fires if the combined condition evaluates to `true` **and** the alert did not fire on the immediately preceding data tick (de-duplication within a session to prevent notification storms).
- If `vix.price` is `null`, conditions on `vix` are skipped (treated as `false`).

---

## 5. UI Wireframe Description

### 5.1 Alerts Button (main toolbar)

```
┌──────────────────────────────────────┐
│  Fear & Greed: 8   Extreme Fear  🔔1 │
│  VIX: 32.5                    [≡ ⚙] │
└──────────────────────────────────────┘
```

A bell icon with a badge count appears in the top-right of the existing compact widget. Badge count reflects the number of enabled alerts. Clicking opens the Alerts Panel.

### 5.2 Alerts Panel (sheet / popover)

```
┌─────────────────────────────────────────────┐
│  Alerts                            [+ New]  │
├─────────────────────────────────────────────┤
│  ● Extreme Fear + High VIX          [✎] [🗑] │
│    F&G < 10  AND  VIX > 30                  │
│    Last fired: 2026-03-31 09:14             │
├─────────────────────────────────────────────┤
│  ○ VIX Spike Only (disabled)        [✎] [🗑] │
│    VIX > 40                                 │
│    Last fired: never                        │
└─────────────────────────────────────────────┘
```

- Filled circle (●) = enabled; empty circle (○) = disabled. Clicking the circle toggles `enabled`.
- `[+ New]` opens the Alert Editor.

### 5.3 Alert Editor (inline form)

```
┌─────────────────────────────────────────────┐
│  Alert name:  [Extreme Fear + High VIX    ] │
│                                             │
│  Condition 1:                               │
│  Metric [Fear & Greed ▾]  Op [< ▾]  Val [10]│
│                                             │
│  Condition 2:                               │
│  Metric [VIX          ▾]  Op [> ▾]  Val [30]│
│                                             │
│  [+ Add condition]                          │
│                                             │
│  Logic: (●) AND  ( ) OR                     │
│                                             │
│           [Cancel]        [Save Alert]      │
└─────────────────────────────────────────────┘
```

- Up to 5 conditions per alert.
- Metric dropdown: `Fear & Greed`, `VIX`.
- Operator dropdown: `<`, `>`, `<=`, `>=`, `==`.
- Value field: numeric input; Fear & Greed range hint 0–100, VIX hint 0–100+.

---

## 6. Acceptance Criteria

- [ ] A user can create an alert with a name, 1–5 conditions, and AND/OR logic via the Alert Editor.
- [ ] A user can toggle any alert on or off from the Alerts Panel without opening the editor.
- [ ] A user can edit or delete any alert from the Alerts Panel.
- [ ] Alerts (including `enabled` state) persist in localStorage and are restored on page reload / app restart.
- [ ] On WS connection (and reconnection), the client sends `set_alerts` with all current alerts automatically.
- [ ] The server evaluates alerts after every `FEAR_GREED_UPDATE` or `VIX_UPDATE` event and sends `alert_triggered` for each newly-satisfied alert.
- [ ] The client does not re-fire a notification for the same alert on consecutive identical data ticks (de-duplication).
- [ ] The client updates `lastTriggeredAt` in localStorage when an `alert_triggered` message is received.
- [ ] A native push notification fires with the alert name as title and the human-readable message as body when `alert_triggered` is received and the Notifications API permission is granted.
- [ ] If Notifications API permission is not granted, the app prompts the user once and degrades gracefully (no notification, but `lastTriggeredAt` still updates).
- [ ] If `vix.price` is `null`, VIX-based conditions are treated as unsatisfied and no false-positive alert fires.
- [ ] The badge count on the bell icon reflects the number of enabled alerts.
- [ ] The UI is accessible: all interactive elements have ARIA labels and are keyboard-navigable.

---

## 7. Out of Scope

The following items are explicitly excluded from this feature iteration:

- **Server-side persistence** — alerts are client-only; no database or user accounts required.
- **Email / SMS / push notifications when app is closed** — notifications fire only while the WS connection is active.
- **Alert history / log** — only `lastTriggeredAt` (most recent) is stored; no full audit trail.
- **Rate limiting on the server** per alert (beyond single-tick de-duplication).
- **Shared / exported alerts** — no import/export or URL-based alert sharing.
- **Notification sound customisation** — platform default sound only.
- **Mobile / iOS client** — macOS and web only in this iteration.
- **Snooze / quiet hours** — all enabled alerts fire at any time the app is open.
