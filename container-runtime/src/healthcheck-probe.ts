import { withDeadline } from "@lando/sdk/command-result";
import { type ProbeError, type ProbeResult, runProbe } from "@lando/sdk/probe";
import type { HealthcheckPlan } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";

export const runHealthcheckProbe = Effect.fn("HealthcheckProbe.run")(function* <E, R, R2>(
  input: { readonly id: string; readonly plan: HealthcheckPlan },
  attempt: Effect.Effect<"green" | "red", E, R>,
  onTimeout: Effect.Effect<"red", never, R2>,
): Effect.fn.Return<ProbeResult, ProbeError, R | R2> {
  const { plan, id } = input;
  const bounded = withDeadline(attempt, Duration.seconds(plan.timeoutSeconds)).pipe(
    Effect.flatMap((exit) => (exit._tag === "TimedOut" ? onTimeout : Effect.succeed(exit.value))),
  );
  return yield* runHealthcheckPhases({ id, plan }, bounded, (value) => value === "green");
});

/** The probe primitive's green means settled here; the caller decides whether settlement is readiness. */
export const runHealthcheckPhases = Effect.fnUntraced(function* <A, E, R>(
  { id, plan }: { readonly id: string; readonly plan: HealthcheckPlan },
  attempt: Effect.Effect<A, E, R>,
  settled: (value: unknown) => boolean,
): Effect.fn.Return<ProbeResult, ProbeError, R> {
  const classify = {
    success: (value: unknown): "green" | "red" => (settled(value) ? "green" : "red"),
    failure: () => "red" as const,
  };
  const startPeriod = plan.startPeriodSeconds ?? 0;
  const cadence = Math.min(1, Math.max(0.001, plan.intervalSeconds));
  const grace =
    startPeriod > 0
      ? yield* runProbe(
          {
            id: `${id}:start-period`,
            policy: {
              maxAttempts: Math.ceil(startPeriod / cadence) + 1,
              delay: Duration.seconds(cadence),
              timeout: Duration.seconds(startPeriod),
              backoff: "fixed",
            },
            classify,
          },
          attempt,
        )
      : undefined;
  if (grace?.outcome === "green") return grace;
  const retried = yield* runProbe(
    {
      id,
      policy: {
        maxAttempts: Math.max(1, plan.retries),
        delay: Duration.seconds(plan.intervalSeconds),
        backoff: "fixed",
      },
      classify,
    },
    attempt,
  );
  return {
    ...retried,
    attempts: (grace?.attempts ?? 0) + retried.attempts,
    elapsedMs: (grace?.elapsedMs ?? 0) + retried.elapsedMs,
  };
});
