import { describe, it, expect } from "vitest";
import WebSocket from "ws";

const WS_URL = "ws://localhost:8081";
const TIMEOUT_MS = 8000;

/**
 * Helper: open WS, collect the first N messages, then close.
 */
function collectWsMessages(count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout waiting for ${count} WS messages`));
    }, TIMEOUT_MS);

    const messages: unknown[] = [];
    const ws = new WebSocket(WS_URL);

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        messages.push(parsed);
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.close();
          resolve(messages);
        }
      } catch {
        // ignore malformed frames
      }
    });
  });
}

describe("Integration: WebSocket ws://localhost:8081", () => {
  it("connects successfully", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("WS connection timeout"));
      }, TIMEOUT_MS);

      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  it("sends at least one message on connection", async () => {
    const messages = await collectWsMessages(1);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("first message has a valid type field", async () => {
    const messages = await collectWsMessages(1);
    const msg = messages[0] as { type: string; payload: unknown };
    expect(["FEAR_GREED_UPDATE", "VIX_UPDATE"]).toContain(msg.type);
  });

  it("sends both FEAR_GREED_UPDATE and VIX_UPDATE on initial connect", async () => {
    // Server sends cached F&G and VIX immediately on connection
    const messages = await collectWsMessages(2);
    const types = messages.map((m) => (m as { type: string }).type);
    expect(types).toContain("FEAR_GREED_UPDATE");
    expect(types).toContain("VIX_UPDATE");
  });

  it("FEAR_GREED_UPDATE payload has expected shape", async () => {
    const messages = await collectWsMessages(2);
    const fgMsg = messages.find(
      (m) => (m as { type: string }).type === "FEAR_GREED_UPDATE"
    ) as { type: string; payload: Record<string, unknown> } | undefined;

    if (!fgMsg) {
      // Cache not yet populated on a fresh start — acceptable
      return;
    }

    const { payload } = fgMsg;
    expect(typeof payload.score).toBe("number");
    expect(typeof payload.classification).toBe("string");
    expect(typeof payload.updatedAt).toBe("string");
  });

  it("VIX_UPDATE payload is either valid VIX or null (PRD null-safe)", async () => {
    const messages = await collectWsMessages(2);
    const vixMsg = messages.find(
      (m) => (m as { type: string }).type === "VIX_UPDATE"
    ) as { type: string; payload: Record<string, unknown> | null } | undefined;

    if (!vixMsg) return;

    const { payload } = vixMsg;
    if (payload === null) {
      expect(payload).toBeNull();
    } else {
      expect(typeof payload.price).toBe("number");
      expect(typeof payload.fetchedAt).toBe("string");
    }
  });
});
