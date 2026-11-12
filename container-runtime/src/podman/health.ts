import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import { type AppPlan, type ServiceHealthObservation, ServiceRunObservation } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo, ServiceSelector } from "@lando/sdk/services";
import { Duration, Effect, Ref, Schema } from "effect";

import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import { redactDetails, redactorFor } from "../redact.ts";
import { inspect } from "./inspect.ts";

const isServiceRunObservation = Schema.is(ServiceRunObservation);

const defaultServiceHealthPolicy: RetryPolicy = {
  maxAttempts: 30,
  delay: Duration.millis(500),
  timeout: Duration.seconds(15),
};

const classifyObservation = (value: unknown): "green" | "yellow" | "red" => {
  if (!isServiceRunObservation(value)) return "red";
  if (value.status !== "running") return "red";
  switch (value.health) {
    case undefined:
    case "healthy":
      return "green";
    case "starting":
      return "yellow";
    case "unhealthy":
      return "red";
    default: {
      const exhaustive: never = value.health;
      return exhaustive;
    }
  }
};

export interface WaitForServiceHealthOptions {
  readonly api: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly policy?: RetryPolicy;
}

const missingSuccessfulInspect = (ctx: ProviderErrorContext, service: string) =>
  new ProviderInternalError({
    providerId: ctx.providerId,
    operation: "inspect",
    message: `Service ${service} health probe completed without a captured inspect result.`,
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
  });

const unavailableFromProbe = (
  ctx: ProviderErrorContext,
  input: {
    readonly service: string;
    readonly attempts: number;
    readonly elapsedMs: number;
    readonly outcome: "green" | "yellow" | "red";
    readonly lastHealth?: ServiceHealthObservation;
    readonly lastError?: unknown;
  },
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "inspect",
    message: `Service ${input.service} did not become healthy; final health verdict was ${input.outcome}.`,
    remediation: "Check the service logs and container healthcheck configuration, then retry the command.",
    details: {
      service: input.service,
      attempts: input.attempts,
      elapsedMs: input.elapsedMs,
      ...(input.lastHealth === undefined ? {} : { lastHealth: input.lastHealth }),
      ...(input.lastError === undefined
        ? {}
        : { lastError: redactDetails(input.lastError, redactorFor(ctx)) }),
    },
  });

export const waitForServiceHealth = Effect.fn("RuntimeProvider.waitForServiceHealth")(function* (
  plan: AppPlan,
  target: ServiceSelector,
  options: WaitForServiceHealthOptions,
): Effect.fn.Return<ServiceRuntimeInfo, ProviderError> {
  const ctx = options.ctx;
  const lastInfo = yield* Ref.make<ServiceRuntimeInfo | undefined>(undefined);
  const service = String(target.service);
  const attempt = inspect(plan, target, { api: options.api, ctx }).pipe(
    Effect.tap((info) => Ref.set(lastInfo, info)),
  );

  const result = yield* runProbe(
    {
      id: `provider-${ctx.providerId}-service-health`,
      policy: options.policy ?? defaultServiceHealthPolicy,
      classify: {
        success: classifyObservation,
        failure: () => "red",
      },
    },
    attempt,
  ).pipe(
    mapFailures((cause) =>
      unavailableFromProbe(ctx, {
        service,
        attempts: 0,
        elapsedMs: 0,
        outcome: "red",
        lastError: cause,
      }),
    ),
  );

  const info = yield* Ref.get(lastInfo);
  if (result.outcome === "green") {
    return yield* info === undefined
      ? Effect.fail(missingSuccessfulInspect(ctx, service))
      : Effect.succeed(info);
  }

  return yield* Effect.fail(
    unavailableFromProbe(ctx, {
      service,
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
      outcome: result.outcome,
      ...(info?.status !== "running" || info.health === undefined ? {} : { lastHealth: info.health }),
      ...(result.lastError === undefined ? {} : { lastError: result.lastError }),
    }),
  );
});
