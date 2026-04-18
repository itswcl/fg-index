import type { WebhookConfig } from "@shared/types";

export async function deliverWebhook(
  config: WebhookConfig,
  alertName: string,
  message: string
): Promise<void> {
  // Build the text
  const text = `🔔 ${alertName}: ${message}`;

  let response: globalThis.Response;

  if (config.type === "discord") {
    response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, username: "fg-index" }),
    });
  } else if (config.type === "slack") {
    response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } else if (config.type === "telegram") {
    response = await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text }),
      }
    );
  } else if (config.type === "generic") {
    // Generic JSON POST — structured payload so downstream consumers can
    // key off fields rather than parse the human-readable text.
    response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertName, message, text }),
    });
  } else {
    throw new Error("Unsupported webhook type");
  }

  if (!response.ok) {
    throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
  }
}
