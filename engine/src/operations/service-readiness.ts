import type { ServiceNotReadyError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { HealthcheckRunnerShape, RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Duration, Effect, Fiber, Ref, Result } from "effect";
import { retainReadinessOnInterrupt } from "../lifecycle/readiness-failure.ts";
import { makeHealthcheckRunner } from "../subsystems/healthcheck/runner-factory.ts";
import { failReadiness, inspectReadinessRuntime, isSupervisedTarget } from "./service-readiness-error.ts";
import { makeReadinessProgress } from "./service-readiness-progress.ts";
import { makeServiceSupervision } from "./service-readiness-supervision.ts";
import { waitForService } from "./service-readiness-wait.ts";

export { inspectAppliedService, inspectServiceRunning } from "./service-readiness-error.ts";

export const waitForServiceReadiness = Effect.fn("ServiceReadiness.wait")(function* (options: {
  readonly provider: RuntimeProviderShape;
  readonly plan: AppPlan;
  readonly services: ReadonlyArray<ServiceName>;
  readonly signal?: AbortSignal;
  readonly runner?: HealthcheckRunnerShape;
  readonly initial?: ReadonlyMap<string, ServiceRuntimeInfo>;
}) {
  const runner =
    options.runner ??
    makeHealthcheckRunner({
      exec: options.provider.exec,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const initialFailures = new Map<string, ServiceNotReadyError>();
  const targets = yield* Effect.forEach(
    options.services,
    (service) =>
      Effect.gen(function* () {
        const target = { provider: options.provider, plan: options.plan, service };
        const initial =
          options.initial?.get(String(service)) ??
          (yield* inspectReadinessRuntime(target).pipe(
            Effect.catchTag("ServiceNotReadyError", (error) => {
              if (!isSupervisedTarget(target)) return Effect.fail(error);
              initialFailures.set(String(service), error);
              return Effect.succeed<ServiceRuntimeInfo>({
                app: options.plan.id,
                service,
                providerId: options.plan.provider,
                status: "unknown",
              });
            }),
          ));
        return { target, initial };
      }),
    { concurrency: "unbounded" },
  );
  const progress = yield* makeReadinessProgress(options.plan, options.services);
  const supervision = yield* makeServiceSupervision(targets);
  const work = Effect.gen(function* () {
    const rows = yield* Effect.forEach(
      targets,
      ({ target, initial }) => {
        const failure = initialFailures.get(String(target.service));
        return supervision
          .wait(
            String(target.service),
            failure === undefined ? waitForService(target, initial, runner) : Effect.fail(failure),
          )
          .pipe(Effect.tap(progress.complete));
      },
      { concurrency: "unbounded" },
    );
    return yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const service = options.services.find((name) => String(name) === row.name);
          if (service === undefined) return yield* Effect.die("Readiness row has no service.");
          const finished = yield* supervision.finish(
            { provider: options.provider, plan: options.plan, service },
            row,
          );
          if (finished.state !== row.state) yield* progress.complete(finished);
          const { initial: _initial, ...result } = finished;
          return result;
        }),
      { concurrency: "unbounded" },
    );
  });
  const observe = Effect.forEach(
    targets,
    (entry) => (initialFailures.has(String(entry.target.service)) ? Effect.void : supervision.observe(entry)),
    {
      concurrency: "unbounded",
      discard: true,
    },
  );
  const first = targets[0];
  if (first === undefined) return [];
  const watch = Effect.gen(function* () {
    const last = yield* Ref.make<Result.Result<void, Effect.Error<typeof observe>>>(
      Result.succeed(undefined),
    );
    const budget = Math.max(
      120_000,
      ...targets.map(({ target }) => {
        const check = target.plan.services[target.service]?.healthcheck;
        return check === undefined
          ? 0
          : ((check.startPeriodSeconds ?? 0) +
              Math.max(1, check.retries) * (check.timeoutSeconds + check.intervalSeconds) +
              3) *
              1_000;
      }),
    );
    yield* runProbe(
      {
        id: `readiness:${options.plan.id}:all-services`,
        policy: {
          maxAttempts: Math.ceil(budget / 250) + 1,
          delay: Duration.millis(250),
          timeout: Duration.millis(budget),
        },
        classify: { success: (value) => (value === true ? "green" : "red"), failure: () => "red" },
      },
      Effect.gen(function* () {
        const result = yield* Effect.result(observe);
        yield* Ref.set(last, result);
        return Result.isFailure(result);
      }),
    ).pipe(
      Effect.catchTag("ProbeError", (error) =>
        failReadiness(first.target, { reason: "not-running", lastStatus: error.message }),
      ),
    );
    const result = yield* Ref.get(last);
    return yield* Result.isFailure(result) ? Effect.fail(result.failure) : Effect.never;
  });
  const showing = yield* Effect.forkChild(progress.show);
  const barrier = Effect.raceFirst(work, watch).pipe(
    Effect.onExit((exit) => Fiber.interrupt(showing).pipe(Effect.andThen(progress.finish(exit)))),
  );
  const signal = options.signal;
  if (signal === undefined) return yield* barrier;
  return yield* Effect.raceFirst(
    barrier,
    Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt);
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    }),
  );
}, retainReadinessOnInterrupt);
