import { expect, test } from "bun:test";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { runHealthcheckPhases } from "../src/healthcheck-probe.ts";

test.each([
  {
    label: "authored",
    startupTiming: { startIntervalSeconds: 2 },
    expected: [0, 2_000, 4_000, 5_000, 15_000],
  },
  { label: "omitted", startupTiming: {}, expected: [0, 1_000, 2_000, 3_000, 4_000, 5_000, 15_000] },
])("uses the $label start interval only during the grace period", async ({ startupTiming, expected }) => {
  const plan = {
    kind: "command",
    startPeriodSeconds: 5,
    intervalSeconds: 10,
    timeoutSeconds: 1,
    retries: 2,
    ...startupTiming,
  } as const;

  const attempts = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const times: number[] = [];
      const attempt = Effect.map(Clock.currentTimeMillis, (now) => {
        times.push(now - started);
        return "red";
      });
      const fiber = yield* Effect.forkChild(
        runHealthcheckPhases({ id: "readiness", plan }, attempt, () => false),
      );
      yield* TestClock.adjust("15 seconds");
      yield* Fiber.join(fiber);
      return times;
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect<readonly number[]>(attempts).toEqual(expected);
});
