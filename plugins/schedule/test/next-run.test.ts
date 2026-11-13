import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { scheduleTimezone } from "../src/jobs.ts";
import { formatNextRun, nextRunAt } from "../src/next-run.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const nextIso = (every: string, now: string, timezone = "UTC"): string | undefined => {
  const next = nextRunAt(every, at(now), timezone);
  return next === undefined ? undefined : formatNextRun(next);
};

describe("schedule next run", () => {
  test("@every minutes align to the clock instead of adding the duration", () => {
    expect(nextIso("@every 5m", "2026-11-03T12:02:00Z")).toBe("2026-11-03T12:05:00.000Z");
    expect(nextIso("@every 30s", "2026-11-03T12:02:10Z")).toBe("2026-11-03T12:02:30.000Z");
    expect(nextIso("@every 1s", "2026-11-03T12:02:00Z")).toBe("2026-11-03T12:02:01.000Z");
    expect(nextIso("@every 1h", "2026-11-03T12:02:00Z")).toBe("2026-11-03T13:00:00.000Z");
  });

  test("named macros and 5-field expressions still compute the next occurrence", () => {
    expect(nextIso("@hourly", "2026-11-03T12:30:00Z")).toBe("2026-11-03T13:00:00.000Z");
    expect(nextIso("@daily", "2026-11-03T12:02:00Z")).toBe("2026-11-04T00:00:00.000Z");
    expect(nextIso("*/15 * * * *", "2026-11-03T12:02:00Z")).toBe("2026-11-03T12:15:00.000Z");
  });

  test("the service timezone decides the next occurrence", () => {
    expect(nextIso("@daily", "2026-11-03T23:30:00Z", "Europe/Berlin")).toBe("2026-11-04T23:00:00.000Z");
  });

  test("@every 24h compiles to daily midnight in the job zone", () => {
    expect(nextIso("@every 24h", "2026-11-03T12:02:00Z")).toBe("2026-11-04T00:00:00.000Z");
    expect(nextIso("@every 24h", "2026-11-03T22:30:00Z", "America/Chicago")).toBe("2026-11-04T06:00:00.000Z");
  });

  test("a POSIX TZ colon still resolves the next run in its zone", () => {
    expect(nextIso("@daily", "2026-11-03T23:30:00Z", scheduleTimezone({ TZ: ":America/Chicago" }))).toBe(
      "2026-11-04T06:00:00.000Z",
    );
    expect(
      nextRunAt("@daily", at("2026-11-03T23:30:00Z"), scheduleTimezone({ TZ: ":America/Chicago" })),
    ).toBeDefined();
  });

  test("unrepresentable durations and invalid expressions have no next run", () => {
    expect(nextIso("@every 1h30m", "2026-11-03T12:00:00Z")).toBeUndefined();
    expect(nextIso("@every 1500ms", "2026-11-03T12:00:00Z")).toBeUndefined();
    expect(nextIso("not a cron", "2026-11-03T12:00:00Z")).toBeUndefined();
    expect(formatNextRun(undefined)).toBeUndefined();
  });
});
