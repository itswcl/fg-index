import { isMarketWindowOpen } from "@shared/types";

/** Check the closed window locally; no upstream work until the next opening. */
export function startMarketWindowTask(task: () => Promise<void>, intervalMs: () => number): void {
  const tick = async () => {
    try {
      if (isMarketWindowOpen()) await task();
    } finally {
      setTimeout(() => { void tick(); }, isMarketWindowOpen() ? intervalMs() : 30_000);
    }
  };
  void tick();
}
