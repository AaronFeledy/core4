import { type ProbeError, type ProbeResult, runProbe } from "@lando/sdk/probe";
import type { HealthcheckPlan } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";

export const runHealthcheckProbe = Effect.fn("HealthcheckProbe.run")(function* <E, R, R2>(
  input: { readonly id: string; readonly plan: HealthcheckPlan },
  attempt: Effect.Effect<"green" | "red", E, R>,
  onTimeout: Effect.Effect<"red", never, R2>,
): Effect.fn.Return<ProbeResult, ProbeError, R | R2> {
  const { plan, id } = input;
  const bounded = Effect.timeoutOrElse(attempt, {
    duration: Duration.seconds(plan.timeoutSeconds),
    orElse: () => onTimeout,
  });
  const classify = {
    success: (value: unknown) => (value === "green" ? ("green" as const) : ("red" as const)),
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
          bounded,
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
    bounded,
  );
  return {
    ...retried,
    attempts: (grace?.attempts ?? 0) + retried.attempts,
    elapsedMs: (grace?.elapsedMs ?? 0) + retried.elapsedMs,
  };
});
