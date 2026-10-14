import { completionIntentServices } from "@lando/container-runtime/dependency-gates";
import { runProbe } from "@lando/sdk/probe";
import type { HealthcheckRunnerShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Clock, DateTime, Duration, Effect, Ref, Result } from "effect";
import { startedServiceRow } from "./authority-url.ts";
import {
  type ReadinessTarget,
  failReadiness,
  guardServiceRunning,
  inspectServiceRunning,
  redactorForReadiness,
} from "./service-readiness-error.ts";

export const waitForService = Effect.fn("ServiceReadiness.waitForService")(function* (
  target: ReadinessTarget,
  initial: ServiceRuntimeInfo,
  runner: HealthcheckRunnerShape,
) {
  const service = target.plan.services[target.service];
  if (service === undefined) return yield* Effect.die("Readiness service is absent from the full plan.");
  yield* guardServiceRunning(target, initial);
  const job = completionIntentServices(target.plan).has(String(target.service));
  const healthcheck = job || service.healthcheck?.kind === "none" ? undefined : service.healthcheck;
  const started =
    initial.lastStartedAt === undefined
      ? yield* Clock.currentTimeMillis
      : DateTime.toEpochMillis(DateTime.makeUnsafe(initial.lastStartedAt));
  const inspect = inspectServiceRunning(target, initial);
  const completed = Effect.gen(function* () {
    const last = yield* Ref.make<Result.Result<ServiceRuntimeInfo, Effect.Error<typeof inspect>>>(
      Result.succeed(initial),
    );
    const probe = yield* runProbe(
      {
        id: `readiness:${target.service}:completion`,
        policy: { maxAttempts: 481, delay: Duration.millis(250), timeout: Duration.seconds(120) },
        classify: { success: (done) => (done === true ? "green" : "red"), failure: () => "red" },
      },
      Effect.gen(function* () {
        const observed = yield* Effect.result(inspect);
        yield* Ref.set(last, observed);
        if (Result.isFailure(observed)) return true;
        return observed.success.status !== "running" && observed.success.state !== "running";
      }),
    );
    const observed = yield* Ref.get(last);
    if (Result.isFailure(observed)) return yield* Effect.fail(observed.failure);
    if (probe.outcome !== "green") {
      const redactor = yield* redactorForReadiness;
      return yield* failReadiness(target, {
        reason: "not-running",
        runtime: observed.success,
        ...(probe.lastError === undefined
          ? {}
          : { lastStatus: redactor.redactString(String(probe.lastError)) }),
      });
    }
    return "completed" as const;
  }).pipe(
    Effect.catchTag("ProbeError", (error) =>
      failReadiness(target, { reason: "not-running", lastStatus: error.message }),
    ),
  );
  const healthy =
    healthcheck === undefined
      ? undefined
      : Effect.gen(function* () {
          const result = yield* runner.run(healthcheck, target.plan.id, target.service).pipe(
            Effect.catchTag("HealthcheckTimeoutError", (error) =>
              Effect.gen(function* () {
                return yield* failReadiness(target, {
                  reason: "healthcheck-timeout",
                  runtime: yield* inspect,
                  lastStatus: error.lastStatus,
                  ...(typeof error.probe === "object" &&
                  error.probe !== null &&
                  typeof Reflect.get(error.probe, "attempts") === "number"
                    ? { attempts: Number(Reflect.get(error.probe, "attempts")) }
                    : {}),
                });
              }),
            ),
            Effect.catchTag("HealthcheckError", (error) =>
              Effect.gen(function* () {
                return yield* failReadiness(target, {
                  reason: "healthcheck-failed",
                  runtime: yield* inspect,
                  lastStatus: error.message,
                });
              }),
            ),
          );
          if (!result.healthy)
            return yield* failReadiness(target, {
              reason: "healthcheck-failed",
              runtime: yield* inspect,
              attempts: result.attempts,
              lastStatus: result.lastStatus,
            });
          return "ready" as const;
        });
  const state = yield* healthy !== undefined
    ? healthy
    : job
      ? completed
      : Effect.sleep(
          Duration.millis(Math.min(2_000, Math.max(0, started + 2_000 - (yield* Clock.currentTimeMillis)))),
        ).pipe(Effect.as("running" as const));
  return { ...startedServiceRow(service, yield* inspect), state, initial };
});
