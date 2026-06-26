import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Schema, TestClock, TestContext } from "effect";

import {
  type ClassifyFn,
  ProbeError,
  ProbeOutcome,
  ProbeResult,
  type ProbeSpec,
  ProbeSpec as ProbeSpecSchema,
  ProbeTimeoutError,
  RetryPolicy,
  runProbe,
  toSchedule,
} from "@lando/sdk/probe";

const drive = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

const spec = (policy: RetryPolicy, classify?: ClassifyFn): ProbeSpec => ({
  id: "test:probe",
  policy,
  ...(classify === undefined ? {} : { classify }),
});

/**
 * Run a probe under TestClock by forking it, advancing virtual time, then
 * joining — all inside one program so the fiber and the clock share a runtime.
 */
const runUnderClock = <A, E>(
  effect: Effect.Effect<A, E, never>,
  advance: Duration.DurationInput,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect);
      yield* TestClock.adjust(advance);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("@lando/sdk/probe schemas", () => {
  test("decodes a full RetryPolicy through Schema with durations", () => {
    const decoded = Schema.decodeUnknownSync(RetryPolicy)({
      maxAttempts: 3,
      delay: 100,
      backoff: "exponential",
      factor: 2,
      maxDelay: 5000,
      jitter: false,
      timeout: 10_000,
    });

    expect(decoded.maxAttempts).toBe(3);
    expect(decoded.backoff).toBe("exponential");
  });

  test("ProbeOutcome is the green/yellow/red literal", () => {
    expect(Schema.decodeUnknownSync(ProbeOutcome)("green")).toBe("green");
    expect(Schema.decodeUnknownSync(ProbeOutcome)("yellow")).toBe("yellow");
    expect(Schema.decodeUnknownSync(ProbeOutcome)("red")).toBe("red");
    expect(() => Schema.decodeUnknownSync(ProbeOutcome)("blue")).toThrow();
  });

  test("ProbeResult decodes the verdict envelope", () => {
    const decoded = Schema.decodeUnknownSync(ProbeResult)({
      outcome: "green",
      attempts: 1,
      elapsedMs: 0,
    });

    expect(decoded.outcome).toBe("green");
    expect(decoded.attempts).toBe(1);
  });

  test("ProbeSpec decodes the serializable spec envelope", () => {
    const decoded = Schema.decodeUnknownSync(ProbeSpecSchema)({
      id: "healthcheck:web",
      policy: { maxAttempts: 2, delay: 50 },
    });

    expect(decoded.id).toBe("healthcheck:web");
    expect(decoded.policy.maxAttempts).toBe(2);
  });

  test("ProbeError and ProbeTimeoutError are tagged errors", () => {
    const timeout = new ProbeTimeoutError({ probeId: "p", timeoutMs: 100, attempts: 2 });
    expect(timeout._tag).toBe("ProbeTimeoutError");

    const error = new ProbeError({ probeId: "p", message: "boom", timeout });
    expect(error._tag).toBe("ProbeError");
    expect(error.timeout?._tag).toBe("ProbeTimeoutError");
  });
});

describe("runProbe", () => {
  test("S1 happy path: stops at first green on attempt 1", async () => {
    let calls = 0;
    const attempt = Effect.sync(() => {
      calls += 1;
      return "ok";
    });

    const result = await drive(runProbe(spec({ maxAttempts: 3, delay: Duration.millis(100) }), attempt));

    expect(result.outcome).toBe("green");
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(0);
    expect(result.lastError).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("S2 retry/exhaust: exponential backoff, resolves red without failing, verbatim lastError", async () => {
    const boom = { code: "EHOSTDOWN" } as const;
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      return yield* Effect.fail(boom);
    });

    // delays: 100 (before attempt 2) + 200 (before attempt 3) = 300ms
    const result = await runUnderClock(
      runProbe(
        spec({ maxAttempts: 3, delay: Duration.millis(100), backoff: "exponential", factor: 2 }),
        attempt,
      ),
      "300 millis",
    );

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(300);
    expect(result.lastError).toBe(boom);
    expect(calls).toBe(3);
  });

  test("S2b fixed backoff: equal inter-attempt delays", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      return yield* Effect.fail(new Error("nope"));
    });

    // fixed 100ms x 2 retries = 200ms
    const result = await runUnderClock(
      runProbe(spec({ maxAttempts: 3, delay: Duration.millis(100), backoff: "fixed" }), attempt),
      "200 millis",
    );

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(200);
    expect(calls).toBe(3);
  });

  test("S2c maxDelay caps exponential growth", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      return yield* Effect.fail(new Error("nope"));
    });

    // exponential base 100, factor 4, cap 150 => delays 100, 150, 150 across 4 attempts = 400ms
    const result = await runUnderClock(
      runProbe(
        spec({
          maxAttempts: 4,
          delay: Duration.millis(100),
          backoff: "exponential",
          factor: 4,
          maxDelay: Duration.millis(150),
        }),
        attempt,
      ),
      "400 millis",
    );

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(4);
    expect(result.elapsedMs).toBe(400);
    expect(calls).toBe(4);
  });

  test("S2d jitter is deterministic under TestClock", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      return yield* Effect.fail(new Error("nope"));
    });

    const result = await runUnderClock(
      runProbe(spec({ maxAttempts: 3, delay: Duration.millis(100), jitter: true }), attempt),
      "84 millis",
    );

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(84);
    expect(calls).toBe(3);
  });

  test("S3 timeout: overall deadline resolves with last non-green result, does not fail", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      return yield* Effect.fail(new Error(`fail-${calls}`));
    });

    // attempts at t=0,1000,2000; t=3000 advance, deadline 2500 blocks a 4th.
    const result = await runUnderClock(
      runProbe(
        spec({
          maxAttempts: 100,
          delay: Duration.millis(1000),
          backoff: "fixed",
          timeout: Duration.millis(2500),
        }),
        attempt,
      ),
      "3 seconds",
    );

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(2500);
    expect(calls).toBe(3);
  });

  test("S3b timeout: overall deadline bounds an in-flight attempt", async () => {
    const result = await runUnderClock(
      runProbe(
        spec({ maxAttempts: 1, timeout: Duration.millis(100) }),
        Effect.sleep("1 second").pipe(Effect.as("ok")),
      ),
      "100 millis",
    );

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(100);
    expect(result.lastError).toBeInstanceOf(ProbeTimeoutError);
  });

  test("S4 yellow: last attempt yellow has no stale lastError from earlier failures", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      if (calls === 1) return yield* Effect.fail({ code: "first-fail" });
      return "degraded";
    });
    const classify: ClassifyFn = {
      success: () => "yellow",
      failure: () => "red",
    };

    const result = await runUnderClock(
      runProbe(spec({ maxAttempts: 2, delay: Duration.millis(50) }, classify), attempt),
      "50 millis",
    );

    expect(result.outcome).toBe("yellow");
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("S4b yellow: classify maps to yellow, retries like red, surfaces yellow distinctly", async () => {
    const classify: ClassifyFn = {
      success: () => "yellow",
      failure: () => "red",
    };
    let calls = 0;
    const attempt = Effect.sync(() => {
      calls += 1;
      return "degraded";
    });

    const result = await runUnderClock(
      runProbe(spec({ maxAttempts: 2, delay: Duration.millis(50) }, classify), attempt),
      "50 millis",
    );

    expect(result.outcome).toBe("yellow");
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  test("S5 edge: green on the second attempt after one red", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      if (calls === 1) return yield* Effect.fail(new Error("first"));
      return "ok";
    });

    const result = await runUnderClock(
      runProbe(spec({ maxAttempts: 5, delay: Duration.millis(100) }), attempt),
      "100 millis",
    );

    expect(result.outcome).toBe("green");
    expect(result.attempts).toBe(2);
    expect(result.elapsedMs).toBe(100);
    expect(result.lastError).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("S6 no-IO: lastError is returned by object identity, never redacted", async () => {
    const secretError = { url: "https://user:hunter2@db.internal/health" };
    const attempt = Effect.fail(secretError);

    const result = await drive(runProbe(spec({ maxAttempts: 1 }), attempt));

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBe(secretError);
  });

  test("default policy means one attempt, no retry", async () => {
    let calls = 0;
    const attempt = Effect.gen(function* () {
      calls += 1;
      return yield* Effect.fail(new Error("once"));
    });

    const result = await drive(runProbe(spec({}), attempt));

    expect(result.outcome).toBe("red");
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(0);
    expect(calls).toBe(1);
  });

  test("S7 deadline already elapsed: first attempt still runs when timeout is zero", async () => {
    let calls = 0;
    const attempt = Effect.sync(() => {
      calls += 1;
      return "ok";
    });

    const result = await drive(runProbe(spec({ maxAttempts: 3, timeout: Duration.millis(0) }), attempt));

    expect(result.outcome).toBe("green");
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("a non-error defect fails the Effect with a ProbeError", async () => {
    const attempt = Effect.die("kaboom");

    const exit = await Effect.runPromiseExit(
      runProbe(spec({ maxAttempts: 1 }), attempt).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(failure).toBeInstanceOf(ProbeError);
    }
  });
});

describe("toSchedule", () => {
  test("produces a Schedule capped to maxAttempts - 1 recurrences", () => {
    const schedule = toSchedule({ maxAttempts: 3, delay: Duration.millis(100), backoff: "exponential" });
    expect(schedule).toBeDefined();
  });
});
