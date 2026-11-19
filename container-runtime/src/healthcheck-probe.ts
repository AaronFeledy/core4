import { withDeadline } from "@lando/sdk/command-result";
import { runProbeDetailed } from "@lando/sdk/probe";
import type { HealthcheckPlan } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";

export const boundHealthcheckAttempt = <A, E, R>(plan: HealthcheckPlan, attempt: Effect.Effect<A, E, R>) =>
  withDeadline(attempt, Duration.seconds(plan.timeoutSeconds));

export const runHealthcheckProbe = Effect.fn("HealthcheckProbe.runVerdict")(function* <E, R, R2>(
  input: { readonly id: string; readonly plan: HealthcheckPlan },
  attempt: Effect.Effect<"green" | "red", E, R>,
  onTimeout: Effect.Effect<"red", never, R2>,
) {
  const bounded = boundHealthcheckAttempt(input.plan, attempt).pipe(
    Effect.flatMap((exit) => (exit._tag === "TimedOut" ? onTimeout : Effect.succeed(exit.value))),
  );
  return (yield* runHealthcheckPhases(input, bounded, (value) => value === "green")).result;
});

export const runHealthcheckPhases = Effect.fn("HealthcheckProbe.run")(function* <A, E, R>(
  { id, plan }: { readonly id: string; readonly plan: HealthcheckPlan },
  attempt: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
) {
  const classify = (value: A): "green" | "red" => (ready(value) ? "green" : "red");
  const startPeriod = plan.startPeriodSeconds ?? 0;
  const cadence = Math.min(1, Math.max(0.001, plan.intervalSeconds));
  const grace =
    startPeriod > 0
      ? yield* runProbeDetailed(
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
  if (grace?.result.outcome === "green") return grace;
  const retried = yield* runProbeDetailed(
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
    result: {
      ...retried.result,
      attempts: (grace?.result.attempts ?? 0) + retried.result.attempts,
      elapsedMs: (grace?.result.elapsedMs ?? 0) + retried.result.elapsedMs,
    },
  };
});
