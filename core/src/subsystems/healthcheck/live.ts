import { Duration, Effect, Layer, Ref } from "effect";

import { HealthcheckError, HealthcheckTimeoutError } from "@lando/sdk/errors";
import { type ProbeResult, runProbe } from "@lando/sdk/probe";
import type { HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type ExecResult,
  type ExecTarget,
  HealthcheckRunner,
  type HealthcheckRunnerShape,
  type CommandSpec as ProviderCommandSpec,
  type ProviderError,
  RuntimeProvider,
} from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";

export interface HealthcheckExec {
  readonly exec: (
    target: ExecTarget,
    command: ProviderCommandSpec,
  ) => Effect.Effect<ExecResult, ProviderError>;
}

type AttemptStatus =
  | { readonly _tag: "ok" }
  | { readonly _tag: "exit"; readonly code: number }
  | { readonly _tag: "provider"; readonly message: string }
  | { readonly _tag: "timeout" };

type AttemptOutcome = "green" | "red";

interface AttemptContext {
  readonly deps: HealthcheckExec;
  readonly target: ExecTarget;
  readonly command: ProviderCommandSpec;
  readonly timeoutSeconds: number;
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

const makeAttempt = (context: AttemptContext): Effect.Effect<AttemptOutcome> =>
  Effect.gen(function* () {
    const completed = yield* Effect.timeoutTo(
      Effect.either(context.deps.exec(context.target, context.command)),
      {
        duration: Duration.seconds(context.timeoutSeconds),
        onSuccess: (result) => result,
        onTimeout: () => "timeout" as const,
      },
    );

    if (completed === "timeout") {
      yield* Ref.set(context.status, { _tag: "timeout" });
      return "red";
    }

    if (completed._tag === "Left") {
      yield* Ref.set(context.status, { _tag: "provider", message: providerMessage(completed.left) });
      return "red";
    }

    if (completed.right.exitCode === 0) {
      yield* Ref.set(context.status, { _tag: "ok" });
      return "green";
    }

    yield* Ref.set(context.status, { _tag: "exit", code: completed.right.exitCode });
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

export const makeHealthcheckRunner = (deps: HealthcheckExec): HealthcheckRunnerShape => ({
  id: "provider-exec",
  run: (plan, appId, service) =>
    Effect.gen(function* () {
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

      const { provider: command, rendered } = normalizeCommand(plan.command);
      const target: ExecTarget = { app: appId, service };
      const status = yield* Ref.make<AttemptStatus>({
        _tag: "provider",
        message: "Healthcheck command did not run",
      });
      const redactor = yield* resolveRedactor;

      if (plan.startPeriodSeconds !== undefined && plan.startPeriodSeconds > 0) {
        yield* Effect.sleep(Duration.seconds(plan.startPeriodSeconds));
      }

      const result = yield* runProbe(
        {
          id: `healthcheck:${service}`,
          policy: {
            maxAttempts: Math.max(1, plan.retries),
            delay: Duration.seconds(plan.intervalSeconds),
            backoff: "fixed",
          },
          classify: {
            success: (value) => (value === "green" ? "green" : "red"),
            failure: () => "red",
          },
        },
        makeAttempt({ deps, target, command, timeoutSeconds: plan.timeoutSeconds, status }),
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

export const HealthcheckRunnerLive: Layer.Layer<HealthcheckRunner, never, RuntimeProvider> = Layer.effect(
  HealthcheckRunner,
  Effect.map(RuntimeProvider, (provider) => makeHealthcheckRunner({ exec: provider.exec })),
);

export const HealthcheckRunnerDefaultLayer = HealthcheckRunnerLive;
