import { describe, expect, it } from "vitest";
import { isPublicWebhookAddress, parseWebhookDestination } from "./webhookDestination.js";

describe("public address classification", () => {
  // Every special-purpose block in the reviewed IANA registry is rejected,
  // including globally reachable special-service entries (conservative policy).
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.1.2.3", "169.254.169.254",
    "172.16.0.1", "192.0.0.1", "192.0.0.9", "192.0.2.1", "192.31.196.1", "192.52.193.1",
    "192.88.99.1", "192.168.0.1", "192.175.48.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1",
    "::ffff:8.8.8.8", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "100:0:0:1::1",
    "2001::1", "2001:1::1", "2001:1::2", "2001:1::3", "2001:2::1", "2001:3::1",
    "2001:4:112::1", "2001:10::1", "2001:20::1", "2001:30::1", "2001:db8::1",
    "2002::1", "2620:4f:8000::1", "3fff::1", "5f00::1", "fc00::1", "fe80::1", "ff00::1",
    "fec0::1", "4000::1", "fe80::1%eth0", "invalid", "0127.0.0.1",
  ];
  it.each(blocked)("rejects %s", (address) => expect(isPublicWebhookAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "accepts public %s", (address) => expect(isPublicWebhookAddress(address)).toBe(true),
  );
});

describe("webhook URL policy", () => {
  it.each([
    "http://example.com/hook", "https://example.com:8443/hook", "https://user:password@example.com/hook",
    "https://example.com/hook#token", "https://127.0.0.1/hook", "https://2130706433/hook",
    "https://0x7f000001/hook", "https://[::ffff:127.0.0.1]/hook", "https://[::1]/hook", "file:///tmp/test",
  ])("rejects unsafe URL %s", (value) => expect(() => parseWebhookDestination(value)).toThrow(/Webhook destination/));
  it("retains safe path/query and permits explicit default port", () => {
    expect(parseWebhookDestination("https://example.com:443/hook?secret=a").pathname).toBe("/hook");
    expect(parseWebhookDestination("https://example.com:443/hook?secret=a").search).toBe("?secret=a");
  });
});
