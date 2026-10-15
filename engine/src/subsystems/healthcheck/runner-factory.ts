import { Effect, Ref, Result } from "effect";

import { runHealthcheckProbe } from "@lando/container-runtime/healthcheck-probe";
import { HealthcheckError, HealthcheckTimeoutError } from "@lando/sdk/errors";
import type { ProbeResult } from "@lando/sdk/probe";
import type { HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type ExecTarget,
  HealthcheckRunner,
  type HealthcheckRunnerShape,
  type CommandSpec as ProviderCommandSpec,
  type ProviderError,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";

type AttemptStatus =
  | { readonly _tag: "ok" }
  | { readonly _tag: "exit"; readonly code: number }
  | { readonly _tag: "provider"; readonly message: string }
  | { readonly _tag: "timeout" };

type AttemptOutcome = "green" | "red";

interface AttemptContext {
  readonly deps: { readonly exec: RuntimeProviderShape["exec"] };
  readonly target: ExecTarget;
  readonly command: ProviderCommandSpec;
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
  });

const missingCommand = (service: ServiceName): HealthcheckError =>
  new HealthcheckError({
    message: `Command healthcheck for service ${String(service)} requires a command. Add a command healthcheck or disable healthchecks for this service.`,
    service: String(service),
  });

const normalizeCommand = (command: NonNullable<HealthcheckPlan["command"]>) => {
  if (typeof command === "string") return { provider: { command: ["sh", "-c", command] }, rendered: command };
  return { provider: { command: [...command] }, rendered: command.join(" ") };
};

const providerMessage = (error: ProviderError): string => error.message;

const resolveRedactor = Effect.gen(function* () {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None")
    return createStandaloneRedactor("secrets", { sourceEnv: { ...process.env } });
  return yield* redaction.value.forProfile("secrets", { sourceEnv: { ...process.env } });
});

const makeAttempt = Effect.fnUntraced(function* (context: AttemptContext): Effect.fn.Return<AttemptOutcome> {
  const completed = yield* Effect.result(context.deps.exec(context.target, context.command));
  if (Result.isFailure(completed)) {
    yield* Ref.set(context.status, { _tag: "provider", message: providerMessage(completed.failure) });
    return "red";
  }

  if (completed.success.exitCode === 0) {
    yield* Ref.set(context.status, { _tag: "ok" });
    return "green";
  }

  yield* Ref.set(context.status, { _tag: "exit", code: completed.success.exitCode });
  return "red";
});

const toProbeError = (service: ServiceName, cause: unknown): HealthcheckError =>
  new HealthcheckError({
    message: `Healthcheck probe for service ${String(service)} could not run. Re-run the command healthcheck after checking the provider configuration.`,
    service: String(service),
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
    lastStatus: `timeout after ${context.timeoutSeconds}s`,
  });
};

export const makeHealthcheckRunner: (deps: {
  readonly exec: RuntimeProviderShape["exec"];
  readonly signal?: AbortSignal;
}) => HealthcheckRunnerShape = (deps) =>
  HealthcheckRunner.of({
    id: "provider-exec",
    run: Effect.fn("HealthcheckRunner.run")(function* (plan, appId, service) {
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

      const normalized = normalizeCommand(plan.command);
      const command = {
        ...normalized.provider,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      };
      const rendered = normalized.rendered;
      const target: ExecTarget = { app: appId, service };
      const status = yield* Ref.make<AttemptStatus>({
        _tag: "provider",
        message: "Healthcheck command did not run",
      });
      const redactor = yield* resolveRedactor;

      const result = yield* runHealthcheckProbe(
        { id: `healthcheck:${service}`, plan },
        makeAttempt({ deps, target, command, status }),
        Ref.set(status, { _tag: "timeout" }).pipe(Effect.as("red" as const)),
      ).pipe(Effect.mapError((cause) => toProbeError(service, cause)));
      const finalStatus = yield* Ref.get(status);

      if (result.outcome === "green")
        return { healthy: true, service, attempts: result.attempts, lastStatus: "ok" };

      switch (finalStatus._tag) {
        case "timeout":
          return yield* Effect.fail(
            timeoutError({
              service,
              renderedCommand: rendered,
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
            lastStatus: redactor.redactString(`exit ${finalStatus.code}`),
          };
        case "provider":
          return {
            healthy: false,
            service,
            attempts: result.attempts,
            lastStatus: redactor.redactString(finalStatus.message),
          };
        case "ok":
          return { healthy: false, service, attempts: result.attempts, lastStatus: "ok" };
      }
    }),
  });
