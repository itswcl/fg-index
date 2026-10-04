import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverWebhook } from "../services/webhookDelivery.js";
import { postWebhookJson } from "../services/webhookTransport.js";

vi.mock("../services/webhookTransport.js", () => ({ postWebhookJson: vi.fn() }));
const post = vi.mocked(postWebhookJson);
beforeEach(() => { post.mockReset().mockResolvedValue(undefined); });

describe("webhook provider payload compatibility", () => {
  it("Discord preserves content and username", async () => {
    await deliverWebhook({ type: "discord", url: "https://discord.com/api/webhooks/123/abc" }, "Alert", "message");
    expect(post).toHaveBeenCalledWith("https://discord.com/api/webhooks/123/abc", {
      content: "🔔 Alert: message", username: "fg-index",
    });
  });
  it("Slack preserves text", async () => {
    await deliverWebhook({ type: "slack", url: "https://hooks.slack.com/services/T/B/token" }, "Alert", "message");
    expect(post).toHaveBeenCalledWith("https://hooks.slack.com/services/T/B/token", { text: "🔔 Alert: message" });
  });
  it("Telegram preserves valid token and chat_id/text", async () => {
    await deliverWebhook({ type: "telegram", botToken: "123456:ABC-DEF", chatId: "-100" }, "Alert", "message");
    expect(post).toHaveBeenCalledWith("https://api.telegram.org/bot123456:ABC-DEF/sendMessage", {
      chat_id: "-100", text: "🔔 Alert: message",
    });
  });
  it("Telegram token cannot inject a URL query or fragment", async () => {
    await deliverWebhook({ type: "telegram", botToken: "123:abc?x/#", chatId: "-100" }, "Alert", "message");
    const url = new URL(post.mock.calls[0][0]);
    expect(url.hostname).toBe("api.telegram.org");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.pathname).toContain("%3F");
  });
  it("generic preserves structured alert payload", async () => {
    await deliverWebhook({ type: "generic", url: "https://example.com/hook" }, "Alert", "message");
    expect(post).toHaveBeenCalledWith("https://example.com/hook", {
      alertName: "Alert", message: "message", text: "🔔 Alert: message",
    });
  });
});
