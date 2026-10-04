import type { WebhookConfig } from "@shared/types";
import { postWebhookJson } from "./webhookTransport.js";
import { WebhookDeliveryError } from "./webhookDestination.js";

export async function deliverWebhook(
  config: WebhookConfig,
  alertName: string,
  message: string,
): Promise<void> {
  const text = `🔔 ${alertName}: ${message}`;
  if (config.type === "discord") {
    await postWebhookJson(config.url, { content: text, username: "fg-index" });
  } else if (config.type === "slack") {
    await postWebhookJson(config.url, { text });
  } else if (config.type === "telegram") {
    // A token is a single path segment; do not let it inject a path/query/fragment.
    await postWebhookJson(
      `https://api.telegram.org/bot${encodeURIComponent(config.botToken).replace(/%3A/gi, ":")}/sendMessage`,
      { chat_id: config.chatId, text },
    );
  } else if (config.type === "generic") {
    await postWebhookJson(config.url, { alertName, message, text });
  } else {
    throw new WebhookDeliveryError("Unsupported webhook type");
  }
}
