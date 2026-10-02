import { describe, expect, test } from "bun:test";
import { type RetryPolicy, runProbe, toSchedule } from "@lando/sdk/probe";
import { Clock, Duration, Effect, Fiber, TestClock, TestContext } from "effect";

const profiles = [
  { name: "default", policy: {}, times: [0] },
  { name: "zero delay", policy: { maxAttempts: 4 }, times: [0, 0, 0, 0] },
  { name: "fixed", policy: { maxAttempts: 4, delay: Duration.millis(100) }, times: [0, 100, 200, 300] },
  {
    name: "exponential default factor",
    policy: { maxAttempts: 4, delay: Duration.millis(100), backoff: "exponential" },
    times: [0, 100, 300, 700],
  },
  {
    name: "exponential custom factor",
    policy: { maxAttempts: 4, delay: Duration.millis(100), backoff: "exponential", factor: 3 },
    times: [0, 100, 400, 1300],
  },
  {
    name: "capped exponential",
    policy: {
      maxAttempts: 4,
      delay: Duration.millis(100),
      backoff: "exponential",
      factor: 4,
      maxDelay: Duration.millis(150),
    },
    times: [0, 100, 250, 400],
  },
  {
    name: "fixed jitter",
    policy: { maxAttempts: 4, delay: Duration.millis(100), jitter: true },
    times: [0, 61, 84, 169],
  },
  {
    name: "capped exponential jitter",
    policy: {
      maxAttempts: 4,
      delay: Duration.millis(100),
      backoff: "exponential",
      factor: 4,
      maxDelay: Duration.millis(150),
      jitter: true,
    },
    times: [0, 61, 96, 224],
  },
] satisfies readonly {
  readonly name: string;
  readonly policy: RetryPolicy;
  readonly times: readonly number[];
}[];

const underClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect);
      yield* TestClock.adjust(10_000);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("probe timing characterization", () => {
  for (const profile of profiles) {
    test(`${profile.name} stops immediately on the first green`, async () => {
      let calls = 0;
      const result = await underClock(
        runProbe(
          { id: profile.name, policy: profile.policy },
          Effect.sync(() => {
            calls += 1;
          }),
        ),
      );

      expect(calls).toBe(1);
      expect(result).toEqual({ outcome: "green", attempts: 1, elapsedMs: 0 });
    });

    test(`${profile.name} bounds an in-flight attempt at the deadline`, async () => {
      const result = await underClock(
        runProbe(
          { id: profile.name, policy: { ...profile.policy, timeout: Duration.millis(50) } },
          Effect.never,
        ),
      );

      expect(result).toMatchObject({
        outcome: "red",
        attempts: 1,
        elapsedMs: 50,
        lastError: { _tag: "ProbeTimeoutError", probeId: profile.name, timeoutMs: 50, attempts: 1 },
      });
    });

    for (const succeeds of [true, false]) {
      test(`${profile.name} ${succeeds ? "succeeds on its last attempt" : "exhausts its budget"}`, async () => {
        const times: number[] = [];
        const error = { code: "not-ready" };
        const attempt = Effect.gen(function* () {
          times.push(yield* Clock.currentTimeMillis);
          return succeeds && times.length === profile.times.length ? "ready" : yield* Effect.fail(error);
        });

        const result = await underClock(runProbe({ id: profile.name, policy: profile.policy }, attempt));

        expect(times).toEqual(profile.times);
        expect(result).toEqual({
          outcome: succeeds ? "green" : "red",
          attempts: profile.times.length,
          elapsedMs: profile.times.at(-1) ?? 0,
          ...(succeeds ? {} : { lastError: error }),
        });
      });
    }

    test(`${profile.name} schedule ends without an extra recurrence or delay`, async () => {
      const times: number[] = [];
      const effect = Effect.gen(function* () {
        times.push(yield* Clock.currentTimeMillis);
      }).pipe(Effect.repeat(toSchedule(profile.policy)));

      const recurrences = await underClock(effect);

      expect(times).toEqual(profile.times);
      expect(recurrences).toBe(profile.times.length - 1);
    });
  }

  test("deadline truncates a retry delay and prevents an attempt at the deadline", async () => {
    const times: number[] = [];
    const attempt = Effect.gen(function* () {
      times.push(yield* Clock.currentTimeMillis);
      return yield* Effect.fail("not-ready");
    });

    const result = await underClock(
      runProbe(
        {
          id: "deadline",
          policy: { maxAttempts: 10, delay: Duration.millis(100), timeout: Duration.millis(250) },
        },
        attempt,
      ),
    );

    expect(times).toEqual([0, 100, 200]);
    expect(result).toEqual({ outcome: "red", attempts: 3, elapsedMs: 250, lastError: "not-ready" });
  });

  test("deadline interrupts an in-flight attempt and waits for its finalizer", async () => {
    let finalized = 0;
    const attempt = Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized += 1;
        }),
      ),
    );

    const result = await underClock(
      runProbe({ id: "in-flight", policy: { maxAttempts: 4, timeout: Duration.millis(250) } }, attempt),
    );

    expect(result).toMatchObject({
      outcome: "red",
      attempts: 1,
      elapsedMs: 250,
      lastError: { _tag: "ProbeTimeoutError", probeId: "in-flight", timeoutMs: 250, attempts: 1 },
    });
    expect(finalized).toBe(1);
  });
});
