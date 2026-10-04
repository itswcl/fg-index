import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import type { PeerCertificate } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  postWebhookJson, WEBHOOK_TIMEOUT_MS, WEBHOOK_MAX_CONCURRENT,
  WEBHOOK_MAX_QUEUED, WEBHOOK_MAX_RESPONSE_BYTES,
} from "./webhookTransport.js";

const mocks = vi.hoisted(() => ({ dns4: vi.fn(), dns6: vi.fn(), cancel: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ Resolver: class {
  resolve4 = mocks.dns4;
  resolve6 = mocks.dns6;
  cancel = mocks.cancel;
} }));
vi.mock("node:https", () => ({ request: mocks.request }));

let status = 204;
let hold = false;
let peer: string | undefined;
let responseBytes = 0;
const completions: Array<() => void> = [];
const requests: Array<EventEmitter & { end: Mock<[string], void>; destroy: Mock<[], void> }> = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  status = 204; hold = false; peer = undefined; responseBytes = 0;
  completions.length = 0; requests.length = 0;
  vi.clearAllMocks();
  mocks.dns4.mockResolvedValue(["8.8.8.8"]);
  mocks.dns6.mockRejectedValue(Object.assign(new Error("no AAAA"), { code: "ENODATA" }));
  mocks.request.mockImplementation((options: RequestOptions, onResponse: (response: EventEmitter) => void) => {
    const response = Object.assign(new EventEmitter(), { statusCode: status, destroy: vi.fn() });
    const complete = () => {
      onResponse(response);
      if (response.destroy.mock.calls.length) return;
      if (responseBytes) response.emit("data", Buffer.alloc(responseBytes));
      if (!response.destroy.mock.calls.length) response.emit("end");
    };
    const req = Object.assign(new EventEmitter(), {
      end: vi.fn((_body: string) => { completions.push(complete); if (!hold) queueMicrotask(complete); }),
      destroy: vi.fn<[], void>(),
    });
    options.signal?.addEventListener("abort", () => { req.destroy(); req.emit("error", new Error("aborted secret URL")); });
    requests.push(req);
    queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), { remoteAddress: peer ?? options.hostname });
      req.emit("socket", socket);
      socket.emit("secureConnect");
    });
    return req;
  });
});
afterEach(() => { vi.useRealTimers(); });

describe("pinned outbound webhook transport", () => {
  it("connects to numeric public IP, retains Host/SNI/cert checks, and never fetches or re-resolves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await postWebhookJson("https://example.com/hook?token=secret", { text: "hello" });
      const options: RequestOptions = mocks.request.mock.calls[0][0];
      expect(options).toMatchObject({
        hostname: "8.8.8.8", family: 4, port: 443, servername: "example.com",
        path: "/hook?token=secret", method: "POST", agent: false,
        rejectUnauthorized: true,
        headers: { Host: "example.com", "Content-Type": "application/json" },
      });
      const cert = { subjectaltname: "DNS:example.com" } as PeerCertificate;
      expect(options.checkServerIdentity?.("8.8.8.8", cert)).toBeUndefined();
      expect(options.checkServerIdentity?.("8.8.8.8", { subjectaltname: "DNS:evil.com" } as PeerCertificate)).toBeInstanceOf(Error);
      expect(requests[0].end).toHaveBeenCalledWith(JSON.stringify({ text: "hello" }));
      expect(mocks.dns4).toHaveBeenCalledTimes(1);
      expect(mocks.dns6).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it("DNS rebinding cannot alter the connected target after validation", async () => {
    mocks.dns4.mockResolvedValueOnce(["8.8.8.8"]).mockResolvedValue(["127.0.0.1"]);
    await postWebhookJson("https://rebind.example/hook", {});
    expect(mocks.request.mock.calls[0][0].hostname).toBe("8.8.8.8");
    expect(mocks.dns4).toHaveBeenCalledOnce();
  });
  it("does not send the payload if actual TLS peer differs", async () => {
    peer = "127.0.0.1";
    await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("approved address");
    expect(requests[0].end).not.toHaveBeenCalled();
    expect(requests[0].destroy).toHaveBeenCalled();
  });
  it("pins public IPv6 and literal IPv6 without a DNS lookup", async () => {
    await postWebhookJson("https://[2606:4700:4700::1111]/hook", {});
    expect(mocks.dns4).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls[0][0]).toMatchObject({
      hostname: "2606:4700:4700::1111", family: 6, servername: "",
      headers: { Host: "[2606:4700:4700::1111]" },
    });
  });
  it.each([["127.0.0.1"], ["8.8.8.8", "10.0.0.1"], Array(33).fill("8.8.8.8")])(
    "rejects unsafe or oversized DNS address sets", async (...addresses) => {
      mocks.dns4.mockResolvedValue(addresses);
      await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("public Internet");
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
  it("rejects mixed public IPv4/private IPv6 answers", async () => {
    mocks.dns6.mockResolvedValue(["::1"]);
    await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("public Internet");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("fails closed when either family lookup fails unexpectedly, with redacted errors", async () => {
    mocks.dns6.mockRejectedValue(new Error("https://example.com/secret-token"));
    await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("DNS lookup failed");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([301, 302, 303, 307, 308])("never follows redirect status %s", async (redirect) => {
    status = redirect;
    await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("redirects are not supported");
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.dns4).toHaveBeenCalledOnce();
  });
  it("rejects non-success status without upstream body/details", async () => {
    status = 500;
    await expect(postWebhookJson("https://example.com/token", {})).rejects.toThrow("destination rejected");
  });
  it("caps response bytes and destroys the request", async () => {
    responseBytes = WEBHOOK_MAX_RESPONSE_BYTES + 1;
    await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("size limit");
    expect(requests[0].destroy).toHaveBeenCalled();
  });
  it("rejects large request payload before DNS/network", async () => {
    await expect(postWebhookJson("https://example.com/hook", { text: "x".repeat(17000) })).rejects.toThrow("payload exceeded");
    expect(mocks.dns4).not.toHaveBeenCalled();
  });
  it("redacts synchronous request exception text", async () => {
    mocks.request.mockImplementation(() => { throw new Error("token=secret https://example.com"); });
    await expect(postWebhookJson("https://example.com/hook", {})).rejects.toThrow("Webhook delivery failed; check the destination and try again");
  });
  it("end-to-end deadline cancels pending DNS and never starts a late connection", async () => {
    vi.useFakeTimers();
    let finishDns!: (addresses: string[]) => void;
    mocks.dns4.mockImplementation(() => new Promise((resolve) => { finishDns = resolve; }));
    const delivery = postWebhookJson("https://example.com/hook", {}).catch((error: Error) => error.message);
    await flush();
    await vi.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
    expect(await delivery).toMatch(/timed out/);
    expect(mocks.cancel).toHaveBeenCalled();
    finishDns(["8.8.8.8"]);
    await flush();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("deadline covers a slow response and aborts its socket", async () => {
    vi.useFakeTimers(); hold = true;
    const delivery = postWebhookJson("https://example.com/hook", {}).catch((error: Error) => error.message);
    await flush();
    await vi.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
    expect(await delivery).toMatch(/timed out/);
    expect(requests[0].destroy).toHaveBeenCalled();
  });
  it("queues fan-out while bounding simultaneous DNS/network work", async () => {
    hold = true;
    const deliveries = Array.from({ length: 10 }, () => postWebhookJson("https://example.com/hook", {}));
    const done = Promise.all(deliveries);
    await flush();
    expect(mocks.request).toHaveBeenCalledTimes(WEBHOOK_MAX_CONCURRENT);
    for (let completed = 0; completed < 10; completed++) {
      completions[completed]();
      await flush();
      expect(mocks.request.mock.calls.length - completed - 1).toBeLessThanOrEqual(WEBHOOK_MAX_CONCURRENT);
    }
    await done;
    expect(mocks.request).toHaveBeenCalledTimes(10);
  });
  it("bounds its queue and times out waiting calls without leaking capacity", async () => {
    vi.useFakeTimers(); hold = true;
    const deliveries = Array.from({ length: WEBHOOK_MAX_CONCURRENT + WEBHOOK_MAX_QUEUED + 1 },
      () => postWebhookJson("https://example.com/hook", {}));
    const done = Promise.allSettled(deliveries);
    await flush();
    expect(mocks.request).toHaveBeenCalledTimes(WEBHOOK_MAX_CONCURRENT);
    await vi.advanceTimersByTimeAsync(WEBHOOK_TIMEOUT_MS);
    const results = await done;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(results.filter((result) => result.status === "rejected" && /busy/.test(result.reason.message))).toHaveLength(1);
    hold = false;
    await postWebhookJson("https://example.com/hook", {});
  });
});
