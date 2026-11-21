import { completionIntentServices } from "@lando/container-runtime/dependency-gates";
import { listenerAuthorityAction, listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { observeTcpListener } from "@lando/container-runtime/listener-observation";
import { capRedactedLogLines } from "@lando/container-runtime/podman/bring-up";
import { isSupervisedService } from "@lando/container-runtime/supervision";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { type DatabaseClientCheckState, classifyDatabaseClientResult } from "@lando/sdk/database-creds";
import { ServiceNotReadyError } from "@lando/sdk/errors";
import type { AppPlan, DatabaseConnection, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Cause, DateTime, Duration, Effect, Option, Stream } from "effect";
import { databaseCredentialRemediation } from "./database-credentials.ts";

/** A classified login rejection adds credential recovery advice; an unproven state adds none. */
const credentialRemediation = (
  connection: DatabaseConnection | undefined,
  state: DatabaseClientCheckState | undefined,
): string => {
  if (connection === undefined || state === undefined) return "";
  if (state !== "rejected" && state !== "database-missing") return "";
  return ` ${databaseCredentialRemediation(connection.family, state)}`;
};

/**
 * Classify the raw tail before redaction rewrites it: a configured password equal to a word in
 * the rejection text (for example `Login` in SQL Server's `Login failed for user`) would
 * otherwise erase the signal the recovery advice depends on. The raw text stays in this scope;
 * only the verdict leaves it.
 */
const classifyCredentialState = (
  connection: DatabaseConnection | undefined,
  exitCode: number | undefined,
  raw: string,
): DatabaseClientCheckState | undefined =>
  connection === undefined || exitCode === undefined || raw.length === 0
    ? undefined
    : classifyDatabaseClientResult(connection.family, { exitCode, stderr: raw });

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

const failureRuntimes = new WeakMap<ServiceNotReadyError, ServiceRuntimeInfo>();
export const readinessFailureRuntime = (error: ServiceNotReadyError) => failureRuntimes.get(error);

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
  const service = target.plan.services[target.service];
  const diagnose = evidence.reason === "healthcheck-failed" || evidence.reason === "healthcheck-timeout";
  const [listener, logEvidence] = yield* Effect.all(
    [
      diagnose && service !== undefined
        ? observeTcpListener(service, (command) =>
            target.provider.execStream(
              { app: target.plan.id, service: target.service, plan: target.plan },
              command,
            ),
          )
        : Effect.succeed(undefined),
      Stream.runCollect(
        target.provider.logs({ app: target.plan.id, service: target.service }, { follow: false, tail: 50 }),
      ).pipe(
        Effect.map((chunks) => {
          if (chunks.length === 0) return undefined;
          const raw = chunks.map((chunk) => chunk.line).join("\n");
          return {
            tail: {
              service: String(target.service),
              ...capRedactedLogLines(redactor.redactString(raw).split("\n")),
              ...(evidence.runtime?.exitCode === undefined ? {} : { exitCode: evidence.runtime.exitCode }),
              ...(evidence.reason === "healthcheck-timeout" ? { timedOut: true } : {}),
            },
            credentialState: classifyCredentialState(service?.connection, evidence.runtime?.exitCode, raw),
          };
        }),
        Effect.timeout(Duration.seconds(4)),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );
  const name = String(target.service);
  const commands = readinessCommands(target);
  const diagnostic =
    listener !== undefined && service !== undefined ? listenerDiagnostic(listener, service) : undefined;
  const action = diagnostic?.action ?? (diagnose ? listenerAuthorityAction(service) : undefined);
  const healthcheckRemediation =
    diagnose && diagnostic === undefined
      ? " Check the readiness command; readiness: false disables startup readiness."
      : "";
  const error = new ServiceNotReadyError({
    message: `Service ${name} is not ready (${evidence.reason})${diagnostic === undefined ? "" : `: ${diagnostic.finding}`}.${target.plan.extensions["@lando/core/scratch"] === undefined ? " The applied app has been retained." : ""}`,
    app: String(target.plan.name),
    service: name,
    providerId: String(target.provider.id),
    reason: evidence.reason,
    remediation:
      evidence.reason === "inspect-failed"
        ? "Run `lando doctor` to diagnose and restore the provider, then retry start."
        : `${action === undefined ? "" : `${redactor.redactString(action)}\n`}${diagnostic?.authority === undefined ? "" : `${redactor.redactString(diagnostic.authority)}\n`}Run \`${commands.logs}\` to diagnose the service and fix it.${commands.retry === undefined ? "" : ` Then retry \`${commands.retry}\`.`}${healthcheckRemediation}${credentialRemediation(service?.connection, logEvidence?.credentialState)}`,
    ...(listener === undefined ? {} : { listener }),
    ...(evidence.runtime?.exitCode === undefined ? {} : { exitCode: evidence.runtime.exitCode }),
    ...(evidence.runtime === undefined ? {} : { state: redactor.redactString(evidence.runtime.status) }),
    ...(evidence.attempts === undefined ? {} : { attempts: evidence.attempts }),
    ...(evidence.lastStatus === undefined ? {} : { lastStatus: redactor.redactString(evidence.lastStatus) }),
    ...(logEvidence === undefined ? {} : { logTail: logEvidence.tail }),
  });
  if (evidence.runtime !== undefined) failureRuntimes.set(error, evidence.runtime);
  return yield* Effect.fail(error);
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
  const running = runtime.status === "running";
  const job = completionIntentServices(target.plan).has(String(target.service));
  if (initial !== undefined && readinessIncarnation(initial, runtime) !== "same")
    return yield* failReadinessIncarnation(target, runtime);
  if (!running && !(job && runtime.status === "exited" && runtime.exitCode === 0))
    return yield* failReadiness(target, {
      reason: "not-running",
      runtime,
    });
  return runtime;
});

const startedAt = (runtime: ServiceRuntimeInfo) =>
  runtime.lastStartedAt === undefined
    ? undefined
    : DateTime.toEpochMillis(DateTime.makeUnsafe(runtime.lastStartedAt));

export const readinessIncarnation = (initial: ServiceRuntimeInfo, observed: ServiceRuntimeInfo) => {
  if (initial.containerId !== observed.containerId) return "different";
  const before = startedAt(initial);
  const after = startedAt(observed);
  if (before === after) return "same";
  return initial.containerId !== undefined && before !== undefined && after !== undefined && after > before
    ? "restarted"
    : "different";
};

export const failReadinessIncarnation = (target: ReadinessTarget, runtime: ServiceRuntimeInfo) =>
  failReadiness(target, {
    reason: "not-running",
    runtime,
    lastStatus: "Container replaced or restarted during readiness.",
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
