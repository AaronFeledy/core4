/**
 * `@lando/sdk/probe` — the pure retry/backoff/timeout probe primitive.
 *
 * A declarative {@link RetryPolicy} plus a pure runner ({@link runProbe} /
 * {@link toSchedule}) that the `HealthcheckRunner`, `UrlScanner`,
 * `DoctorService`, `Downloader`, and `lando setup` readiness paths all consume
 * to share one deterministic retry/backoff/timeout vocabulary and one
 * green/yellow/red verdict shape.
 *
 * This subpath is the same contracts-only tier as `@lando/sdk/secrets` and
 * `@lando/sdk/expressions`: it constructs no `LandoRuntime`, pulls no service
 * `Layer`, and imports only effect's `Schema`/`Schedule`/`Effect`/`Clock`/
 * `Duration` plus type-only schema imports. It is **not** a `Context.Tag`
 * service and **not** a pluggable abstraction.
 *
 * Its errors ({@link ProbeError}, {@link ProbeTimeoutError}) deliberately live
 * here rather than on the frozen `@lando/sdk/errors` barrel (mirroring
 * `@lando/sdk/expressions`), so adding this primitive widens no frozen error
 * union.
 *
 * The primitive performs no IO, no logging, and no redaction: a
 * {@link ProbeResult.lastError} that embeds a command, URL, or secret MUST be
 * passed through the canonical `RedactionService` by the **consuming surface**
 * before it reaches a lifecycle event, transcript, or `lando info`.
 */
import { type Cause, Clock, Duration, Effect, Schedule, Schema } from "effect";

/**
 * Declarative retry/backoff/timeout policy. All fields are optional with the
 * documented defaults, so an empty policy means "one attempt, no retry".
 */
export const RetryPolicy = Schema.Struct({
  /** Total attempts including the first; default 1 (no retry). */
  maxAttempts: Schema.optional(Schema.Int),
  /** Base delay between attempts; default 0. */
  delay: Schema.optional(Schema.DurationFromMillis),
  /** Backoff curve applied to {@link delay}; default `"fixed"`. */
  backoff: Schema.optional(Schema.Literal("fixed", "exponential")),
  /** Exponential multiplier applied per attempt; default 2. */
  factor: Schema.optional(Schema.Number),
  /** Cap on a single inter-attempt delay; default unbounded. */
  maxDelay: Schema.optional(Schema.DurationFromMillis),
  /** Full jitter applied to each delay; default false. */
  jitter: Schema.optional(Schema.Boolean),
  /** Overall deadline across all attempts; default unbounded. */
  timeout: Schema.optional(Schema.DurationFromMillis),
});

/** Decoded {@link RetryPolicy}. */
export type RetryPolicy = Schema.Schema.Type<typeof RetryPolicy>;

/** Green/yellow/red verdict for a single probe attempt or overall run. */
export const ProbeOutcome = Schema.Literal("green", "yellow", "red");

/** Decoded {@link ProbeOutcome}. */
export type ProbeOutcome = Schema.Schema.Type<typeof ProbeOutcome>;

/**
 * Maps an attempt's success value or failure to a verdict. Returns one of
 * `green` / `yellow` / `red`. `green` stops the run; `yellow` and `red` retry
 * per policy, but `yellow` is surfaced distinctly in the result.
 *
 * The success branch receives the attempt's resolved value; the failure branch
 * receives the attempt's error. Default classification (when no `classify` is
 * supplied): success ⇒ `green`, failure ⇒ `red`.
 */
export interface ClassifyFn {
  readonly success: (value: unknown) => ProbeOutcome;
  readonly failure: (error: unknown) => ProbeOutcome;
}

/**
 * Schema for {@link ProbeSpec}. The `classify` function is intentionally not
 * part of the decoded wire form (functions are not serializable), so the schema
 * validates `id` and `policy` only; a decoded value omits `classify`.
 */
export const ProbeSpec = Schema.Struct({
  id: Schema.String,
  policy: RetryPolicy,
});

/**
 * A probe specification: an id for events/transcripts, the retry policy, and an
 * optional verdict classifier.
 */
export interface ProbeSpec extends Schema.Schema.Type<typeof ProbeSpec> {
  /** Optional verdict classifier; defaults to success ⇒ green, failure ⇒ red. */
  readonly classify?: ClassifyFn | undefined;
}

/** The terminal result of a {@link runProbe} run. Never thrown; always resolved. */
export const ProbeResult = Schema.Struct({
  /** Final verdict. */
  outcome: ProbeOutcome,
  /** Number of attempts performed. */
  attempts: Schema.Int,
  /** Wall-clock-equivalent elapsed time across the run, in milliseconds. */
  elapsedMs: Schema.Number,
  /**
   * The last attempt error, returned verbatim for the consuming surface to
   * redact. Absent when the run ended green or no attempt failed.
   */
  lastError: Schema.optional(Schema.Unknown),
});

/** Decoded {@link ProbeResult}. */
export type ProbeResult = Schema.Schema.Type<typeof ProbeResult>;

/**
 * Deadline-expiry detail carried by {@link ProbeError}. Deliberately exported
 * from this subpath, not the frozen `@lando/sdk/errors` barrel.
 */
export class ProbeTimeoutError extends Schema.TaggedError<ProbeTimeoutError>()("ProbeTimeoutError", {
  /** Probe id the deadline applied to. */
  probeId: Schema.String,
  /** The configured overall deadline, in milliseconds. */
  timeoutMs: Schema.Number,
  /** Attempts completed before the deadline expired. */
  attempts: Schema.Int,
}) {}

/**
 * The probe primitive's tagged error. {@link runProbe} resolves with a
 * {@link ProbeResult} for exhausted attempts and elapsed timeouts rather than
 * failing, so this error is reserved for genuinely exceptional conditions (an
 * invalid policy). It deliberately does NOT ride the frozen
 * `@lando/sdk/errors` barrel.
 */
export class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  /** Probe id this error applies to. */
  probeId: Schema.String,
  /** Human-readable message. */
  message: Schema.String,
  /** Optional deadline-expiry sub-shape. */
  timeout: Schema.optional(ProbeTimeoutError),
  /** Underlying cause, if any. */
  cause: Schema.optional(Schema.Unknown),
}) {}

const DEFAULT_FACTOR = 2;

const policyMaxAttempts = (policy: RetryPolicy): number => {
  const value = policy.maxAttempts ?? 1;
  return value < 1 ? 1 : value;
};

const baseDelayMillis = (policy: RetryPolicy): number =>
  policy.delay === undefined ? 0 : Duration.toMillis(policy.delay);

const maxDelayMillis = (policy: RetryPolicy): number | undefined =>
  policy.maxDelay === undefined ? undefined : Duration.toMillis(policy.maxDelay);

const jitterRatioForRetryIndex = (retryIndex: number): number =>
  (Math.imul(retryIndex + 1, 2_654_435_761) >>> 0) / 0xffff_ffff;

/**
 * The inter-attempt delay (in milliseconds) before the attempt at the given
 * 0-based retry index (0 = delay before the 2nd attempt). Applies the backoff
 * curve, the `maxDelay` cap, and full jitter.
 */
const delayForRetryIndex = (policy: RetryPolicy, retryIndex: number): number => {
  const base = baseDelayMillis(policy);
  if (base <= 0) return 0;

  const factor = policy.factor ?? DEFAULT_FACTOR;
  const curve = policy.backoff ?? "fixed";
  const raw = curve === "exponential" ? base * factor ** retryIndex : base;

  const cap = maxDelayMillis(policy);
  const capped = cap === undefined ? raw : Math.min(raw, cap);

  if (policy.jitter === true) {
    // Deterministic full jitter in [0, capped], keyed by retry index so
    // TestClock assertions can prove exact elapsed time without wall-clock or
    // ambient random state.
    return Math.floor(jitterRatioForRetryIndex(retryIndex) * capped);
  }
  return capped;
};

/**
 * Build an effect {@link Schedule} from a {@link RetryPolicy}: it recurs up to
 * `maxAttempts - 1` times with the policy's backoff/jitter/cap applied to the
 * base delay. Pure and deterministic under Effect's `TestClock`.
 */
export const toSchedule = (policy: RetryPolicy): Schedule.Schedule<number> => {
  // recurs(n) permits n recurrences after the first run; its output is the
  // 0-based recurrence count, which is exactly the retry index the curve wants.
  const maxRetries = policyMaxAttempts(policy) - 1;
  return Schedule.addDelay(Schedule.recurs(maxRetries), (recurrenceCount) =>
    Duration.millis(delayForRetryIndex(policy, recurrenceCount)),
  );
};

/**
 * Run `attempt` to a green/yellow/red verdict under `spec.policy`.
 *
 * - Stops at the first `green`.
 * - Retries on `red` / `yellow` per policy; `yellow` is surfaced distinctly.
 * - Resolves with a {@link ProbeResult} (`outcome`, `attempts`, `elapsedMs`,
 *   optional `lastError`). Exhausting `maxAttempts` or hitting the overall
 *   `timeout` resolves with the last non-green result — it does NOT fail the
 *   Effect.
 * - Performs no IO, logging, or redaction; `lastError` is returned verbatim.
 * - Deterministic under Effect's `TestClock`: every delay and the overall
 *   deadline are driven through `Clock`/`Schedule`, never `Date.now()` or
 *   `setTimeout`.
 */
export const runProbe = <A, E, R>(
  spec: ProbeSpec,
  attempt: Effect.Effect<A, E, R>,
): Effect.Effect<ProbeResult, ProbeError, R> =>
  Effect.gen(function* () {
    const classify = spec.classify;
    const maxAttempts = policyMaxAttempts(spec.policy);
    const timeoutMs = spec.policy.timeout === undefined ? undefined : Duration.toMillis(spec.policy.timeout);

    const start = yield* Clock.currentTimeMillis;
    const deadline = timeoutMs === undefined ? undefined : start + timeoutMs;

    let attempts = 0;
    let lastOutcome: ProbeOutcome = "red";
    let lastError: unknown;
    let hadError = false;

    while (attempts < maxAttempts) {
      // Enforce the overall deadline before performing the attempt.
      if (deadline !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        if (now >= deadline) break;
      }

      attempts += 1;
      const run = Effect.exit(attempt);
      const completed =
        deadline === undefined
          ? yield* Effect.map(run, (exit) => ({ _tag: "Completed" as const, exit }))
          : yield* Effect.timeoutTo(run, {
              duration: Duration.millis(deadline - (yield* Clock.currentTimeMillis)),
              onSuccess: (exit) => ({ _tag: "Completed" as const, exit }),
              onTimeout: () => ({ _tag: "TimedOut" as const }),
            });

      if (completed._tag === "TimedOut") {
        lastOutcome = "red";
        lastError = new ProbeTimeoutError({ probeId: spec.id, timeoutMs: timeoutMs ?? 0, attempts });
        hadError = true;
        break;
      }

      const { exit } = completed;

      if (exit._tag === "Success") {
        lastOutcome = classify === undefined ? "green" : classify.success(exit.value);
        if (lastOutcome === "green") {
          hadError = false;
          lastError = undefined;
          break;
        }
      } else {
        const error = yield* extractFailure(spec, exit.cause);
        lastError = error;
        hadError = true;
        lastOutcome = classify === undefined ? "red" : classify.failure(error);
        if (lastOutcome === "green") {
          break;
        }
      }

      // No more attempts available: stop without an extra delay.
      if (attempts >= maxAttempts) break;

      const wait = delayForRetryIndex(spec.policy, attempts - 1);
      if (deadline !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        const remaining = deadline - now;
        if (remaining <= 0) break;
        if (wait > 0) yield* Effect.sleep(Duration.millis(Math.min(wait, remaining)));
        // After sleeping toward the deadline, the next loop guard re-checks it.
      } else if (wait > 0) {
        yield* Effect.sleep(Duration.millis(wait));
      }
    }

    const end = yield* Clock.currentTimeMillis;

    return {
      outcome: lastOutcome,
      attempts,
      elapsedMs: end - start,
      ...(hadError ? { lastError } : {}),
    } satisfies ProbeResult;
  });

/**
 * Extract the attempt's failure value verbatim from its cause. A typed failure
 * (`E`) is returned as-is; a defect is surfaced as a {@link ProbeError} so the
 * runner fails the Effect rather than silently masking a bug.
 */
const extractFailure = (spec: ProbeSpec, cause: Cause.Cause<unknown>): Effect.Effect<unknown, ProbeError> =>
  Effect.gen(function* () {
    const failures = causeFailures(cause);
    if (failures.length > 0) return failures[0];

    // No typed failure means an interruption or defect — fail loudly.
    yield* Effect.fail(
      new ProbeError({
        probeId: spec.id,
        message: `Probe "${spec.id}" attempt failed with a non-error cause`,
        cause,
      }),
    );
    return undefined;
  });

const causeFailures = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> => {
  const out: unknown[] = [];
  const visit = (node: Cause.Cause<unknown>): void => {
    switch (node._tag) {
      case "Fail":
        out.push(node.error);
        return;
      case "Sequential":
      case "Parallel":
        visit(node.left);
        visit(node.right);
        return;
      default:
        return;
    }
  };
  visit(cause);
  return out;
};
