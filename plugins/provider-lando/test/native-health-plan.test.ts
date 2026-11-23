import { describe, expect, test } from "bun:test";
import { HEALTH_START_INTERVAL_LABEL } from "@lando/container-runtime/labels";
import { managedHealthRunKey } from "@lando/container-runtime/podman/managed-health-units";
import { type HealthRun, decodeHealthRun, healthTimerPlan } from "../src/native-health-plan.ts";

const id = "c".repeat(64);
const startedAt = "2026-11-23T11:03:09.582703484-06:00";
const startedAtMs = 1_795_453_389_582;

const inspect = (input: {
  readonly running?: boolean;
  readonly healthcheck?: unknown;
  readonly labels?: Readonly<Record<string, string>> | null;
}) =>
  JSON.stringify({
    Id: id,
    State: { Running: input.running ?? true, StartedAt: startedAt },
    Config: { Labels: input.labels ?? null, Healthcheck: input.healthcheck },
  });

const check = { Test: ["CMD", "true"], Interval: 30e9, Timeout: 5e9, StartPeriod: 10e9, Retries: 3 };

describe("decodeHealthRun", () => {
  test("reads the effective check, the start interval label and the full StartedAt", () => {
    expect(
      decodeHealthRun(
        inspect({ healthcheck: check, labels: { [HEALTH_START_INTERVAL_LABEL]: "2000000000" } }),
      ),
    ).toEqual({
      containerId: id,
      key: managedHealthRunKey(id, startedAt),
      startedAtMs,
      intervalMs: 30_000,
      startPeriodMs: 10_000,
      timeoutSeconds: 5,
      startIntervalMs: 2_000,
    });
  });

  test.each([
    ["a stopped container", { running: false, healthcheck: check }],
    ["no healthcheck", { healthcheck: null }],
    ["a disabled check", { healthcheck: { ...check, Test: ["NONE"] } }],
    ["Podman's manual-only interval", { healthcheck: { ...check, Interval: 0 } }],
  ])("schedules nothing for %s", (_name, input) => {
    expect(decodeHealthRun(inspect(input))).toBeUndefined();
  });
});

describe("healthTimerPlan", () => {
  const run: HealthRun = {
    containerId: id,
    key: "k",
    startedAtMs: 0,
    intervalMs: 30_000,
    startPeriodMs: 10_000,
    timeoutSeconds: 5,
  };

  test("without a start interval, one main timer first fires one interval out", () => {
    expect(healthTimerPlan(run, 1_000)).toEqual([
      { role: "main", firstMs: 30_000, cadenceMs: 30_000, takesOverFromStart: false },
    ]);
  });

  test("a start interval runs its own timer until the rest of the start period ends", () => {
    expect(healthTimerPlan({ ...run, startIntervalMs: 2_000 }, 4_000)).toEqual([
      { role: "start", firstMs: 2_000, cadenceMs: 2_000, takesOverFromStart: false },
      { role: "main", firstMs: 6_000, cadenceMs: 30_000, takesOverFromStart: true },
    ]);
  });

  test("a start interval whose start period already ended adds no start timer", () => {
    expect(healthTimerPlan({ ...run, startIntervalMs: 2_000 }, 10_000).map(({ role }) => role)).toEqual([
      "main",
    ]);
  });
});
