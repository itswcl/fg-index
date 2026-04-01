import type { WebhookConfig } from "@shared/types";

export async function deliverWebhook(
  config: WebhookConfig,
  alertName: string,
  message: string
): Promise<void> {
  // Build the text
  const text = `🔔 ${alertName}: ${message}`;

  try {
    if (config.type === "discord") {
      await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, username: "fg-index" }),
      });
    } else if (config.type === "slack") {
      await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } else if (config.type === "telegram") {
      await fetch(
        `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: config.chatId, text }),
        }
      );
    }
  } catch (err) {
    // Log but never throw — webhook failure must not crash the server
    process.stderr.write(
      JSON.stringify({ event: "webhook_delivery_error", error: String(err) }) +
        "\n"
    );
  }
}
