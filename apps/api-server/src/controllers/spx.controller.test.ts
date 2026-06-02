import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";

vi.mock("../schedulers/spx.scheduler.js", () => ({
  getCachedSpx: vi.fn(() => null),
}));

describe("spx.controller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a short dashboard cache window", async () => {
    const headers = new Map<string, string>();
    const res = {
      setHeader: vi.fn((key: string, value: string) => {
        headers.set(key, value);
      }),
      json: vi.fn(),
    } as unknown as Response;

    const { getSpx } = await import("./spx.controller.js");
    getSpx({} as never, res);

    expect(headers.get("Cache-Control")).toBe(
      "public, max-age=10, stale-while-revalidate=20"
    );
    expect(res.json).toHaveBeenCalledWith(null);
  });
});
