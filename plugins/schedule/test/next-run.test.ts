import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { nextRunAt } from "../src/next-run.ts";

describe("schedule next run", () => {
  test("advances @every from the current instant", () => {
    const now = DateTime.makeUnsafe("2026-11-03T12:00:00Z");
    const next = nextRunAt("@every 1s", now, "UTC");
    expect(next).toBeDefined();
    expect(DateTime.toEpochMillis(next ?? now) - DateTime.toEpochMillis(now)).toBe(1000);
  });

  test("computes the next hourly run in the parent timezone", () => {
    const now = DateTime.makeUnsafe("2026-11-03T12:30:00Z");
    const next = nextRunAt("@hourly", now, "UTC");
    expect(DateTime.formatIso(next ?? now)).toBe("2026-11-03T13:00:00.000Z");
  });
});
