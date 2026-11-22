import { boundHealthcheckAttempt, runHealthcheckPhases } from "@lando/container-runtime/healthcheck-probe";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { FailureRoleAnnotation, mapDefectCause, mapFailures } from "@lando/sdk/command-result";
import { HealthcheckError, HealthcheckTimeoutError } from "@lando/sdk/errors";
import type { ProbeResult } from "@lando/sdk/probe";
import type { ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  HealthcheckRunner,
  type HealthcheckRunnerShape,
  type ProcessResult,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { Cause, Context, Effect, Exit } from "effect";
import {
  type HostProbeRunners,
  interruptOnAbort,
  prepareHealthcheckAttempt,
  validateProbeTarget,
} from "./attempt.ts";

type AttemptStatus =
  | { readonly _tag: "ok" }
  | { readonly _tag: "exit"; readonly code: number; readonly stderr: string }
  | { readonly _tag: "provider"; readonly message: string }
  | { readonly _tag: "timeout" };

interface TimeoutContext {
  readonly service: ServiceName;
  readonly renderedCommand: string;
  readonly timeoutSeconds: number;
  readonly result: ProbeResult;
  readonly redactor: Redactor;
}

const resolveRedactor = Effect.gen(function* () {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None")
    return createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  return yield* redaction.value.forProfile("secrets", { sourceEnv: { ...process.env } });
});

const makeAttempt = Effect.fnUntraced(function* <E extends { readonly message: string }>(
  attempt: Effect.Effect<ProcessResult, E>,
): Effect.fn.Return<AttemptStatus, E> {
  const completed = yield* Effect.exit(attempt);
  if (Exit.isFailure(completed)) {
    const [reason] = completed.cause.reasons;
    if (
      completed.cause.reasons.length !== 1 ||
      reason === undefined ||
      !Cause.isFailReason(reason) ||
      Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation) !== undefined
    )
      return yield* Effect.failCause(completed.cause);
    return { _tag: "provider", message: reason.error.message };
  }
  return completed.value.exitCode === 0
    ? { _tag: "ok" }
    : {
        _tag: "exit",
        code: completed.value.exitCode,
        stderr: completed.value.stderr,
      };
});

const toProbeError = (service: ServiceName, cause: unknown): HealthcheckError =>
  new HealthcheckError({
    message: `Healthcheck probe for service ${String(service)} could not run. Re-run the probe after checking the provider configuration.`,
    service: String(service),
    remediation: `Inspect \`lando logs -s ${String(service)}\` and the healthcheck probe configuration for service ${String(service)}, then retry.`,
    cause,
  });

const timeoutError = (context: TimeoutContext): HealthcheckTimeoutError => {
  const probe = {
    command: context.renderedCommand,
    outcome: context.result.outcome,
    attempts: context.result.attempts,
    elapsedMs: context.result.elapsedMs,
    ...(context.result.lastError === undefined ? {} : { lastError: context.result.lastError }),
  };

  return new HealthcheckTimeoutError({
    message: context.redactor.redactString(
      `Healthcheck command "${context.renderedCommand}" for service ${String(context.service)} timed out after ${context.timeoutSeconds}s.`,
    ),
    service: String(context.service),
    probe: context.redactor.redactValue(probe),
    lastStatus: context.redactor
      .redactString(
        `timeout after ${context.timeoutSeconds}s; ${context.result.outcome}; attempts ${context.result.attempts}; elapsed ${context.result.elapsedMs}ms; ${context.renderedCommand}`,
      )
      .slice(0, 2048),
    remediation: context.redactor.redactString(
      `Inspect \`lando logs -s ${String(context.service)}\` for probe "${context.renderedCommand}", confirm the service is healthy, and increase the healthcheck timeout (currently ${context.timeoutSeconds}s) if needed.`,
    ),
  });
};

export const makeHealthcheckRunner: (deps: {
  readonly exec: RuntimeProviderShape["exec"];
  readonly runners?: HostProbeRunners;
  readonly signal?: AbortSignal;
}) => HealthcheckRunnerShape = (deps) =>
  HealthcheckRunner.of({
    id: "provider-exec",
    run: Effect.fn("HealthcheckRunner.run")(function* (plan, appId, service, appPlan) {
      if (deps.signal?.aborted === true) return yield* Effect.interrupt;
      yield* validateProbeTarget(plan, service);
      if (plan.kind === "none") return { healthy: true, service, attempts: 0, lastStatus: "skipped" };

      const prepared = yield* prepareHealthcheckAttempt({
        probe: plan,
        app: appId,
        service,
        exec: deps.exec,
        ...(appPlan === undefined ? {} : { plan: appPlan }),
        ...(deps.runners === undefined ? {} : { runners: deps.runners }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      const rendered = prepared.rendered;
      const redactor = yield* resolveRedactor;
      const safeRendered = redactor.redactString(rendered).slice(0, 512);
      const renderedTarget =
        plan.kind !== "command"
          ? `${plan.kind} probe`
          : plan.target === undefined
            ? "custom probe"
            : rendered
                .split(" ")
                .slice(1, 3)
                .map((value) => redactor.redactString(value).slice(0, 192))
                .join(" ");

      const { result, last } = yield* interruptOnAbort(
        runHealthcheckPhases(
          { id: `healthcheck:${service}`, plan },
          boundHealthcheckAttempt(plan, makeAttempt(prepared.run)).pipe(
            Effect.map(
              (exit): AttemptStatus => (exit._tag === "TimedOut" ? { _tag: "timeout" } : exit.value),
            ),
          ),
          (attempt) => attempt._tag === "ok",
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.failCause(mapDefectCause(cause, () => "Healthcheck command defect.")),
          ),
          mapFailures(() => toProbeError(service, "Healthcheck attempt failed while settling.")),
        ),
        deps.signal,
      );
      const finalStatus: AttemptStatus = last?.value ?? {
        _tag: "provider",
        message: "Healthcheck command did not run",
      };

      if (result.outcome === "green")
        return { healthy: true, service, attempts: result.attempts, lastStatus: "ok" };

      switch (finalStatus._tag) {
        case "timeout":
          return yield* Effect.fail(
            timeoutError({
              service,
              renderedCommand: safeRendered,
              timeoutSeconds: plan.timeoutSeconds,
              result,
              redactor,
            }),
          );
        case "exit":
          return {
            healthy: false,
            service,
            attempts: result.attempts,
            lastStatus: redactor
              .redactString(
                `exit ${finalStatus.code}; ${result.outcome}; attempts ${result.attempts}; elapsed ${result.elapsedMs}ms; ${renderedTarget}; ${redactor.redactString(finalStatus.stderr).slice(-1536)}`,
              )
              .slice(0, 2048),
          };
        case "provider":
          return {
            healthy: false,
            service,
            attempts: result.attempts,
            lastStatus:
              `${plan.executionTarget === "host" ? "host" : "provider"} failure; ${result.outcome}; attempts ${result.attempts}; elapsed ${result.elapsedMs}ms; ${renderedTarget}; ${redactor.redactString(finalStatus.message).slice(-1536)}`.slice(
                0,
                2048,
              ),
          };
        case "ok":
          return { healthy: false, service, attempts: result.attempts, lastStatus: "ok" };
      }
    }),
  });
