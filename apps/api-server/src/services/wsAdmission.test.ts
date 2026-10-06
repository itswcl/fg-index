import { describe, expect, it } from "vitest";
import { createWsAdmission, resolveWsClientIp } from "./wsAdmission.js";

describe("WebSocket client address resolution", () => {
  it("trusts only the rightmost Caddy-forwarded address from a loopback peer", () => {
    expect(resolveWsClientIp("127.0.0.1", "198.51.100.9, 203.0.113.7")).toBe("203.0.113.7");
    expect(resolveWsClientIp("::ffff:127.0.0.1", ["198.51.100.9", "203.0.113.7"])).toBe(
      "203.0.113.7",
    );
    expect(resolveWsClientIp("::ffff:7f00:1", "198.51.100.9, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("ignores forged forwarding headers from non-loopback peers", () => {
    expect(resolveWsClientIp("203.0.113.10", "198.51.100.99")).toBe("203.0.113.10");
  });

  it("falls back to the loopback peer when the forwarded address is invalid", () => {
    expect(resolveWsClientIp("127.0.0.1", "client-controlled-value")).toBe("127.0.0.1");
    expect(resolveWsClientIp("not-an-ip", "203.0.113.7")).toBeNull();
  });
});

describe("WebSocket admission", () => {
  it("enforces the global and per-IP active-connection caps and releases once", () => {
    const admission = createWsAdmission({ maxConnections: 2, maxConnectionsPerIp: 1 });
    const first = admission.admit("203.0.113.1");
    const sameIp = admission.admit("203.0.113.1");
    const second = admission.admit("203.0.113.2");
    const global = admission.admit("203.0.113.3");

    expect(first.allowed).toBe(true);
    expect(sameIp).toMatchObject({ allowed: false, reason: "ip-connection-limit" });
    expect(second.allowed).toBe(true);
    expect(global).toMatchObject({ allowed: false, reason: "global-connection-limit" });

    if (first.allowed) {
      first.release();
      first.release();
    }
    expect(admission.getStats().activeConnections).toBe(1);
    if (second.allowed) second.release();
    expect(admission.getStats().activeConnections).toBe(0);
    expect(admission.admit("203.0.113.1").allowed).toBe(true);
  });

  it("limits reconnect bursts while allowing reconnects after the window", () => {
    let currentTime = 1_000;
    const admission = createWsAdmission({
      maxConnections: 5,
      maxConnectionsPerIp: 2,
      maxUpgradesPerIp: 2,
      upgradeWindowMs: 100,
      now: () => currentTime,
    });

    for (let index = 0; index < 2; index += 1) {
      const accepted = admission.admit("203.0.113.4");
      expect(accepted.allowed).toBe(true);
      if (accepted.allowed) accepted.release();
    }
    expect(admission.admit("203.0.113.4")).toMatchObject({
      allowed: false,
      reason: "ip-upgrade-rate-limit",
    });

    currentTime += 101;
    const afterWindow = admission.admit("203.0.113.4");
    expect(afterWindow.allowed).toBe(true);
    if (afterWindow.allowed) afterWindow.release();
  });

  it("bounds the number of tracked client addresses", () => {
    const admission = createWsAdmission({ maxConnections: 2, maxTrackedIps: 1 });
    const first = admission.admit("203.0.113.1");
    expect(first.allowed).toBe(true);
    if (first.allowed) first.release();
    expect(admission.admit("203.0.113.2")).toMatchObject({
      allowed: false,
      reason: "tracked-ip-limit",
    });
  });
});
