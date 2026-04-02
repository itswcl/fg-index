import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deliverWebhook } from "../services/webhookDelivery.js";
import type { WebhookConfig } from "@shared/types";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deliverWebhook()", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockResolvedValue(new Response(null, { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it("Discord: posts to webhook URL with correct content and username", async () => {
    const config: WebhookConfig = {
      type: "discord",
      url: "https://discord.com/api/webhooks/123/abc",
    };

    await deliverWebhook(config, "AlertName", "Fear & Greed is 8 (< 10)");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      content: "🔔 AlertName: Fear & Greed is 8 (< 10)",
      username: "fg-index",
    });
  });

  it("Slack: posts to webhook URL with correct text", async () => {
    const config: WebhookConfig = {
      type: "slack",
      url: "https://hooks.slack.com/services/T000/B000/xxxx",
    };

    await deliverWebhook(config, "My Alert", "VIX is 32.1 (> 30)");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/T000/B000/xxxx");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      text: "🔔 My Alert: VIX is 32.1 (> 30)",
    });
  });

  it("Telegram: posts to bot API with correct chat_id and text", async () => {
    const config: WebhookConfig = {
      type: "telegram",
      botToken: "123456:ABC-DEF",
      chatId: "-100987654321",
    };

    await deliverWebhook(config, "AlertName", "Fear & Greed is 8 (< 10)");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.telegram.org/bot123456:ABC-DEF/sendMessage"
    );
    expect(url).toContain("api.telegram.org/bot");
    expect(url).toContain("/sendMessage");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      chat_id: "-100987654321",
      text: "🔔 AlertName: Fear & Greed is 8 (< 10)",
    });
  });

  it("throws when fetch rejects with a network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const config: WebhookConfig = {
      type: "discord",
      url: "https://discord.com/api/webhooks/fail/test",
    };

    await expect(
      deliverWebhook(config, "Alert", "some message")
    ).rejects.toThrow("Network error");
  });

  it("throws when the HTTP response is not ok", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 400, statusText: "Bad Request" }));

    const config: WebhookConfig = {
      type: "slack",
      url: "https://hooks.slack.com/services/T000/B000/xxxx",
    };

    await expect(
      deliverWebhook(config, "Alert", "some message")
    ).rejects.toThrow("HTTP 400");
  });
});
