import ipaddr from "ipaddr.js";

export const DEFAULT_WS_CONNECTIONS_PER_IP = 8;
export const DEFAULT_WS_UPGRADES_PER_IP = 30;
export const DEFAULT_WS_UPGRADE_WINDOW_MS = 60_000;
export const MAX_WS_TRACKED_IPS = 512;

export type WsAdmissionRejection =
  | "global-connection-limit"
  | "ip-connection-limit"
  | "ip-upgrade-rate-limit"
  | "tracked-ip-limit";

export type WsAdmissionOptions = {
  maxConnections: number;
  maxConnectionsPerIp?: number;
  maxUpgradesPerIp?: number;
  upgradeWindowMs?: number;
  maxTrackedIps?: number;
  now?: () => number;
};

type IpState = {
  activeConnections: number;
  acceptedUpgrades: number[];
};

export type WsAdmissionResult =
  | { allowed: false; reason: WsAdmissionRejection }
  | { allowed: true; release: () => void };

function normalizedIp(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return ipaddr.process(value.trim()).toString().toLowerCase();
  } catch {
    return null;
  }
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

/**
 * Caddy is the only remote proxy and connects to the API over loopback. Caddy
 * appends the address it observed to X-Forwarded-For, so only the rightmost
 * entry is used. Headers from every non-loopback peer are ignored.
 */
export function resolveWsClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
): string | null {
  const peer = normalizedIp(remoteAddress);
  if (!peer) return null;
  if (!isLoopback(peer)) return peer;

  const forwarded = Array.isArray(forwardedFor)
    ? forwardedFor.join(",")
    : forwardedFor;
  if (forwarded) {
    const rightmost = forwarded.split(",").at(-1);
    const proxiedClient = normalizedIp(rightmost);
    if (proxiedClient) return proxiedClient;
  }
  return peer;
}

export function createWsAdmission(options: WsAdmissionOptions) {
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_WS_CONNECTIONS_PER_IP;
  const maxUpgradesPerIp = options.maxUpgradesPerIp ?? DEFAULT_WS_UPGRADES_PER_IP;
  const upgradeWindowMs = options.upgradeWindowMs ?? DEFAULT_WS_UPGRADE_WINDOW_MS;
  const maxTrackedIps = options.maxTrackedIps ?? MAX_WS_TRACKED_IPS;
  const now = options.now ?? Date.now;
  const ipStates = new Map<string, IpState>();
  let activeConnections = 0;

  function pruneExpired(currentTime: number): void {
    for (const [ip, state] of ipStates) {
      state.acceptedUpgrades = state.acceptedUpgrades.filter(
        (time) => currentTime - time < upgradeWindowMs,
      );
      if (state.activeConnections === 0 && state.acceptedUpgrades.length === 0) {
        ipStates.delete(ip);
      }
    }
  }

  return {
    admit(ip: string): WsAdmissionResult {
      const currentTime = now();
      pruneExpired(currentTime);

      let state = ipStates.get(ip);
      if (!state && ipStates.size >= maxTrackedIps) {
        return { allowed: false, reason: "tracked-ip-limit" };
      }
      if (!state) {
        state = { activeConnections: 0, acceptedUpgrades: [] };
        ipStates.set(ip, state);
      }

      if (activeConnections >= options.maxConnections) {
        return { allowed: false, reason: "global-connection-limit" };
      }
      if (state.activeConnections >= maxConnectionsPerIp) {
        return { allowed: false, reason: "ip-connection-limit" };
      }
      if (state.acceptedUpgrades.length >= maxUpgradesPerIp) {
        return { allowed: false, reason: "ip-upgrade-rate-limit" };
      }

      state.activeConnections += 1;
      state.acceptedUpgrades.push(currentTime);
      activeConnections += 1;

      let released = false;
      return {
        allowed: true,
        release() {
          if (released) return;
          released = true;
          state!.activeConnections -= 1;
          activeConnections -= 1;
          if (state!.activeConnections === 0 && state!.acceptedUpgrades.length === 0) {
            ipStates.delete(ip);
          }
        },
      };
    },

    getStats() {
      return { activeConnections, trackedIps: ipStates.size };
    },
  };
}
