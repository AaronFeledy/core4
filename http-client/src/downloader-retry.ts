/**
 * Bounded transient retry for one verified download, driven by `runProbe`.
 *
 * Each attempt is a complete scoped transfer (GET + body + verify + persist),
 * so a failed attempt's response, temp file, and file handle are released
 * before backoff and the next GET. Only failures recorded as transient by the
 * error mapping are retried; everything else ends the run on its first
 * failure. Interruption is never retried. No overall deadline applies: three
 * attempts bound the request count, so a slow failure can take three
 * transport waits plus backoff.
 */
import { Cause, Duration, Effect, Exit, Option, Ref } from "effect";

import { DownloadFetchError } from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";

import type { DownloadError } from "./downloader-errors.ts";
import { failureObservation } from "./downloader-failure.ts";
import { isTransientDownloadFailure } from "./downloader-transient.ts";

const MAX_ATTEMPTS = 3;

const TRANSIENT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: MAX_ATTEMPTS,
  delay: Duration.seconds(1),
  backoff: "exponential",
  factor: 2,
  maxDelay: Duration.seconds(4),
};

const SINGLE_ATTEMPT_POLICY: RetryPolicy = { maxAttempts: 1 };

interface TransientRetryInput<A> {
  readonly enabled: boolean;
  /** Counts network attempts; read by the caller for the post-download event. */
  readonly attempts: Ref.Ref<number>;
  /** One complete, self-scoped transfer attempt. */
  readonly attempt: Effect.Effect<A, DownloadError>;
  /** Published before backing off for the next attempt. */
  readonly onRetry: (reason: string, nextAttempt: number, maxAttempts: number) => Effect.Effect<void>;
}

/** The typed error when the cause holds nothing else; defects and interrupts are never retried or rewritten. */
const soleFailure = <A>(exit: Exit.Exit<A, DownloadError>): DownloadError | undefined => {
  if (Exit.isSuccess(exit) || exit.cause.reasons.length !== 1) return undefined;
  const [reason] = exit.cause.reasons;
  return reason !== undefined && Cause.isFailReason(reason) ? reason.error : undefined;
};

const failureReason = <A>(exit: Exit.Exit<A, DownloadError>): string | undefined => {
  const failure = soleFailure(exit);
  return failure?._tag === "DownloadFetchError" && isTransientDownloadFailure(failure)
    ? failureObservation(failure)
    : undefined;
};

/** Stamp the attempt count onto a final fetch failure; exhausted transient runs say so. */
const annotateFailure = (error: DownloadError, attempts: number, exhausted: boolean) =>
  error._tag === "DownloadFetchError"
    ? new DownloadFetchError({
        message: exhausted ? `${error.message} Gave up after ${attempts} attempts.` : error.message,
        reason: error.reason,
        transportCode: error.transportCode,
        urlOrigin: error.urlOrigin,
        status: error.status,
        trustCause: error.trustCause,
        remediation: error.remediation,
        cause: error.cause,
        attempts,
      })
    : error;

export const runWithTransientRetry = Effect.fnUntraced(function* <A>(
  input: TransientRetryInput<A>,
): Effect.fn.Return<A, DownloadError> {
  const maxAttempts = input.enabled ? MAX_ATTEMPTS : 1;
  const last = yield* Ref.make<Option.Option<Exit.Exit<A, DownloadError>>>(Option.none());
  const once = Effect.gen(function* () {
    const attempt = yield* Ref.updateAndGet(input.attempts, (count) => count + 1);
    const exit = yield* Effect.exit(input.attempt);
    yield* Ref.set(last, Option.some(exit));
    const reason = failureReason(exit);
    if (reason === undefined || attempt >= maxAttempts) return "done" as const;
    yield* input.onRetry(reason, attempt + 1, maxAttempts);
    return "retry" as const;
  });
  yield* runProbe(
    {
      id: "downloader-transient-retry",
      policy: input.enabled ? TRANSIENT_RETRY_POLICY : SINGLE_ATTEMPT_POLICY,
      classify: { success: (verdict) => (verdict === "retry" ? "red" : "green"), failure: () => "red" },
    },
    once,
  ).pipe(Effect.orDie);

  const recorded = yield* Ref.get(last);
  if (Option.isNone(recorded)) return yield* Effect.die("internal: no download attempt ran");
  const exit = recorded.value;
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = soleFailure(exit);
  if (failure === undefined) return yield* Effect.failCause(exit.cause);
  const attempts = yield* Ref.get(input.attempts);
  const exhausted = input.enabled && attempts >= maxAttempts && failureReason(exit) !== undefined;
  return yield* Effect.fail(annotateFailure(failure, attempts, exhausted));
});
