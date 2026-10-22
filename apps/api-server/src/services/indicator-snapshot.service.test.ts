import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FearGreedSchema } from "@shared/types";
let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs(); vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const snapshot = { score: 45, classification: "Fear", previousClose: 42, oneWeekAgo: 40,
  oneMonthAgo: 50, oneYearAgo: 55, updatedAt: "2026-10-16T21:00:00.000Z" };

describe("restart indicator snapshots", () => {
  it("atomically preserves the latest complete value across module restart", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fg-snapshots-"));
    vi.stubEnv("INDICATOR_SNAPSHOT_DIR", directory); vi.resetModules();
    let mod = await import("./indicator-snapshot.service.js");
    await Promise.all([mod.saveIndicatorSnapshot("fear-greed", snapshot), mod.saveIndicatorSnapshot("fear-greed", { ...snapshot, score: 46 })]);
    expect(JSON.parse(await readFile(path.join(directory, "fear-greed.json"), "utf8")).score).toBe(46);
    vi.resetModules(); mod = await import("./indicator-snapshot.service.js");
    expect(mod.loadIndicatorSnapshot("fear-greed", FearGreedSchema)).toMatchObject({ score: 46 });
  });

  it("ignores corrupt or invalid snapshots and does not require disk persistence", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fg-snapshots-"));
    vi.stubEnv("INDICATOR_SNAPSHOT_DIR", directory); vi.resetModules();
    const mod = await import("./indicator-snapshot.service.js");
    await writeFile(path.join(directory, "fear-greed.json"), "{partial");
    expect(mod.loadIndicatorSnapshot("fear-greed", FearGreedSchema)).toBeNull();
    await writeFile(path.join(directory, "fear-greed.json"), JSON.stringify({ score: "invalid" }));
    expect(mod.loadIndicatorSnapshot("fear-greed", FearGreedSchema)).toBeNull();
  });

  it("hydrates the closed-window scheduler without an upstream request", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "fg-snapshots-"));
    vi.stubEnv("INDICATOR_SNAPSHOT_DIR", directory); vi.resetModules();
    await writeFile(path.join(directory, "fear-greed.json"), JSON.stringify(snapshot));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T18:00:00Z"));
    const scheduler = await import("../schedulers/fear-greed.scheduler.js");
    scheduler.startFearGreedScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.getCachedFearGreed()).toEqual(snapshot);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers(); vi.unstubAllGlobals();
  });
});
