import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { env } from "../config/env.js";

type Indicator = "fear-greed" | "vix" | "spx";
const pending = new Map<Indicator, Promise<void>>();
const saved = new Map<Indicator, string>();

/** Disk snapshots are optional; invalid/missing files never prevent startup. */
export function loadIndicatorSnapshot<T>(indicator: Indicator, schema: z.ZodType<T>): T | null {
  if (!env.INDICATOR_SNAPSHOT_DIR) return null;
  try {
    const content = readFileSync(path.join(env.INDICATOR_SNAPSHOT_DIR, `${indicator}.json`), "utf8");
    const parsed = schema.safeParse(JSON.parse(content));
    if (!parsed.success) return null;
    saved.set(indicator, content);
    return parsed.data;
  } catch {
    return null;
  }
}

/** Serialize per indicator and atomically replace the previous complete snapshot. */
export function saveIndicatorSnapshot(indicator: Indicator, data: unknown): Promise<void> {
  if (!env.INDICATOR_SNAPSHOT_DIR) return Promise.resolve();
  const content = JSON.stringify(data);
  const next = (pending.get(indicator) ?? Promise.resolve()).then(async () => {
    if (saved.get(indicator) === content) return;
    await mkdir(env.INDICATOR_SNAPSHOT_DIR, { recursive: true, mode: 0o750 });
    const destination = path.join(env.INDICATOR_SNAPSHOT_DIR, `${indicator}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o640 });
    await rename(temporary, destination);
    saved.set(indicator, content);
  }).catch(() => {
    // Keep serving the live memory snapshot if optional disk persistence fails.
    process.stderr.write(`Indicator snapshot write failed: ${indicator}\n`);
  });
  pending.set(indicator, next);
  return next;
}
