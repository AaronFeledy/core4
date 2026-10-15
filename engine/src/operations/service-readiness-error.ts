import { completionIntentServices } from "@lando/container-runtime/dependency-gates";
import { capRedactedLogLines } from "@lando/container-runtime/podman/bring-up";
import { isSupervisedService } from "@lando/container-runtime/supervision";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Cause, DateTime, Duration, Effect, Option, Stream } from "effect";

export interface ReadinessTarget {
  readonly provider: RuntimeProviderShape;
  readonly plan: AppPlan;
  readonly service: ServiceName;
}

export const readinessCommands = (target: ReadinessTarget) => {
  if (target.plan.extensions["@lando/core/scratch"] !== undefined)
    return { logs: `lando scratch logs ${target.plan.id}`, retry: undefined };
  if (String(target.plan.id) === "global")
    return { logs: `lando global:logs -s ${target.service}`, retry: "lando global:start" };
  return { logs: `lando logs -s ${target.service}`, retry: "lando start" };
};

export const isSupervisedTarget = (target: ReadinessTarget): boolean => {
  const service = target.plan.services[target.service];
  return (
    service !== undefined &&
    !completionIntentServices(target.plan).has(String(target.service)) &&
    isSupervisedService(service)
  );
};

export const redactorForReadiness = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(RedactionService);
  return Option.isSome(service)
    ? yield* service.value.forProfile("secrets", { sourceEnv: { ...process.env } })
    : createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
});

export const failReadiness = Effect.fn("ServiceReadiness.fail")(function* (
  target: ReadinessTarget,
  evidence: {
    readonly reason: ServiceNotReadyError["reason"];
    readonly runtime?: ServiceRuntimeInfo;
    readonly attempts?: number;
    readonly lastStatus?: string | undefined;
  },
) {
  const redactor = yield* redactorForReadiness;
  const logTail = yield* Stream.runCollect(
    target.provider.logs({ app: target.plan.id, service: target.service }, { follow: false, tail: 50 }),
  ).pipe(
    Effect.map((chunks) => {
      if (chunks.length === 0) return undefined;
      return {
        service: String(target.service),
        ...capRedactedLogLines(
          redactor.redactString(chunks.map((chunk) => chunk.line).join("\n")).split("\n"),
        ),
        ...(evidence.runtime?.exitCode === undefined ? {} : { exitCode: evidence.runtime.exitCode }),
        ...(evidence.reason === "healthcheck-timeout" ? { timedOut: true } : {}),
      };
    }),
    Effect.timeout(Duration.seconds(4)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined),
    ),
  );
  const name = String(target.service);
  const commands = readinessCommands(target);
  const healthcheckRemediation =
    evidence.reason === "not-running" || evidence.reason === "inspect-failed"
      ? ""
      : " Fix or relax the healthcheck: configuration, or set healthcheck: { disable: true } to turn the probe off.";
  return yield* Effect.fail(
    new ServiceNotReadyError({
      message: `Service ${name} is not ready (${evidence.reason}).${target.plan.extensions["@lando/core/scratch"] === undefined ? " The applied app has been retained." : ""}`,
      app: String(target.plan.name),
      service: name,
      providerId: String(target.provider.id),
      reason: evidence.reason,
      remediation:
        evidence.reason === "inspect-failed"
          ? "Run `lando doctor` to diagnose and restore the provider, then retry start."
          : `Run \`${commands.logs}\` to diagnose the service and fix it.${commands.retry === undefined ? "" : ` Then retry \`${commands.retry}\`.`}${healthcheckRemediation}`,
      ...(evidence.runtime?.exitCode === undefined ? {} : { exitCode: evidence.runtime.exitCode }),
      ...(evidence.runtime === undefined
        ? {}
        : { state: redactor.redactString(evidence.runtime.state ?? evidence.runtime.status) }),
      ...(evidence.attempts === undefined ? {} : { attempts: evidence.attempts }),
      ...(evidence.lastStatus === undefined
        ? {}
        : { lastStatus: redactor.redactString(evidence.lastStatus) }),
      ...(logTail === undefined ? {} : { logTail }),
    }),
  );
});

export const inspectReadinessRuntime = Effect.fn("ServiceReadiness.inspect")(function* (
  target: ReadinessTarget,
) {
  return yield* target.provider
    .inspect({ app: target.plan.id, service: target.service })
    .pipe(
      Effect.catch((error) => failReadiness(target, { reason: "inspect-failed", lastStatus: error.message })),
    );
});

export const guardServiceRunning = Effect.fn("ServiceReadiness.guardRunning")(function* (
  target: ReadinessTarget,
  runtime: ServiceRuntimeInfo,
  initial?: ServiceRuntimeInfo,
) {
  const running = runtime.status === "running" || runtime.state === "running";
  const job = completionIntentServices(target.plan).has(String(target.service));
  const restarted =
    initial !== undefined &&
    (initial.containerId !== runtime.containerId ||
      (initial.lastStartedAt === undefined
        ? undefined
        : DateTime.toEpochMillis(DateTime.makeUnsafe(initial.lastStartedAt))) !==
        (runtime.lastStartedAt === undefined
          ? undefined
          : DateTime.toEpochMillis(DateTime.makeUnsafe(runtime.lastStartedAt))));
  if (restarted || (!running && !(job && runtime.exitCode === 0)))
    return yield* failReadiness(target, {
      reason: "not-running",
      runtime,
      ...(restarted ? { lastStatus: "Container replaced or restarted during readiness." } : {}),
    });
  return runtime;
});

export const inspectServiceRunning = (target: ReadinessTarget, initial?: ServiceRuntimeInfo) =>
  inspectReadinessRuntime(target).pipe(
    Effect.flatMap((runtime) => guardServiceRunning(target, runtime, initial)),
  );

export const inspectAppliedService = (target: ReadinessTarget) =>
  inspectReadinessRuntime(target).pipe(
    Effect.flatMap((runtime) =>
      isSupervisedTarget(target) ? Effect.succeed(runtime) : guardServiceRunning(target, runtime),
    ),
  );
