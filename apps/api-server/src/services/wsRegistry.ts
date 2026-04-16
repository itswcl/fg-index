import type { WebSocket } from "ws";

// ─── User ⇄ socket registry ──────────────────────────────────────
// Multiple tabs / devices per user → Set<WebSocket>. Anonymous (no JWT)
// sockets are not tracked here; they receive market data only.

const userSockets = new Map<string, Set<WebSocket>>();

export function registerUserSocket(userId: string, ws: WebSocket): void {
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(ws);
}

export function unregisterUserSocket(userId: string, ws: WebSocket): void {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(userId);
}

export function getSocketsForUser(userId: string): WebSocket[] {
  const set = userSockets.get(userId);
  return set ? [...set] : [];
}

export function __clearRegistryForTests(): void {
  userSockets.clear();
}
