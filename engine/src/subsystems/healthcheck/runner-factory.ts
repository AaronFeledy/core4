import { Effect, Ref, Result } from "effect";

import { runHealthcheckProbe } from "@lando/container-runtime/healthcheck-probe";
import { HealthcheckError, HealthcheckTimeoutError } from "@lando/sdk/errors";
import type { ProbeResult } from "@lando/sdk/probe";
import type { HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  HealthcheckRunner,
  type HealthcheckRunnerShape,
  type ProcessResult,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import {
  type HostProbeRunners,
  interruptOnAbort,
  prepareHealthcheckAttempt,
  validateProbeTarget,
} from "./attempt.ts";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

type AttemptStatus =
  | { readonly _tag: "ok" }
  | { readonly _tag: "exit"; readonly code: number; readonly stderr: string }
  | { readonly _tag: "provider"; readonly message: string }
  | { readonly _tag: "timeout" };

type AttemptOutcome = "green" | "red";

interface AttemptContext {
  readonly attempt: Effect.Effect<ProcessResult, { readonly message: string }>;
  readonly status: Ref.Ref<AttemptStatus>;
}

interface TimeoutContext {
  readonly service: ServiceName;
  readonly renderedCommand: string;
  readonly timeoutSeconds: number;
  readonly result: ProbeResult;
  readonly redactor: Redactor;
}

const providerExecUnsupported = (plan: HealthcheckPlan, service: ServiceName): HealthcheckError =>
  new HealthcheckError({
    message: `The provider-exec healthcheck runner only supports command healthchecks. Configure service ${String(service)} with a command healthcheck, or disable the ${plan.kind} healthcheck for this provider.`,
    service: String(service),
    remediation: `Configure service ${String(service)} with a command healthcheck, or disable the ${plan.kind} healthcheck for this provider.`,
  });

const missingCommand = (service: ServiceName): HealthcheckError =>
  new HealthcheckError({
    message: `Command healthcheck for service ${String(service)} requires a command. Add a command healthcheck or disable healthchecks for this service.`,
    service: String(service),
    remediation: `Add a command to the healthcheck for service ${String(service)}, or disable healthchecks for this service.`,
  });

const resolveRedactor = Effect.gen(function* () {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None")
    return createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  return yield* redaction.value.forProfile("secrets", { sourceEnv: { ...process.env } });
});

const makeAttempt = Effect.fnUntraced(function* (context: AttemptContext): Effect.fn.Return<AttemptOutcome> {
  const completed = yield* Effect.result(context.attempt);
  if (Result.isFailure(completed)) {
    yield* Ref.set(context.status, { _tag: "provider", message: completed.failure.message });
    return "red";
  }

  if (completed.success.exitCode === 0) {
    yield* Ref.set(context.status, { _tag: "ok" });
    return "green";
  }

  yield* Ref.set(context.status, {
    _tag: "exit",
    code: completed.success.exitCode,
    stderr: completed.success.stderr,
  });
  return "red";
});

const toProbeError = (service: ServiceName, cause: unknown): HealthcheckError =>
  new HealthcheckError({
    message: `Healthcheck probe for service ${String(service)} could not run. Re-run the command healthcheck after checking the provider configuration.`,
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
      switch (plan.kind) {
        case "none":
          return { healthy: true, service, attempts: 0, lastStatus: "skipped" };
        case "http":
        case "tcp":
          return yield* Effect.fail(providerExecUnsupported(plan, service));
        case "command":
          break;
      }

      if (plan.command === undefined) return yield* Effect.fail(missingCommand(service));

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
      const status = yield* Ref.make<AttemptStatus>({
        _tag: "provider",
        message: "Healthcheck command did not run",
      });
      const redactor = yield* resolveRedactor;
      const safeRendered = redactor.redactString(rendered).slice(0, 512);
      const renderedTarget =
        plan.target === undefined
          ? "custom probe"
          : rendered
              .split(" ")
              .slice(1, 3)
              .map((value) => redactor.redactString(value).slice(0, 192))
              .join(" ");

      const result = yield* interruptOnAbort(
        runHealthcheckProbe(
          { id: `healthcheck:${service}`, plan },
          makeAttempt({ attempt: prepared.run, status }),
          Ref.set(status, { _tag: "timeout" }).pipe(Effect.as("red" as const)),
        ).pipe(Effect.mapError((cause) => toProbeError(service, cause))),
        deps.signal,
      );
      const finalStatus = yield* Ref.get(status);

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
