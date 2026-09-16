import { Duration, Effect, Ref } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import type { AppPlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo, ServiceSelector } from "@lando/sdk/services";

import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import { redactDetails } from "../redact.ts";
import { inspect } from "./inspect.ts";

const defaultServiceHealthPolicy: RetryPolicy = {
  maxAttempts: 30,
  delay: Duration.millis(500),
  timeout: Duration.seconds(15),
};

const healthFromProbeValue = (value: unknown): ServiceRuntimeInfo["health"] | "invalid" => {
  if (typeof value !== "object" || value === null) return "invalid";
  if (!("health" in value)) return undefined;
  const health = value.health;
  switch (health) {
    case undefined:
    case "healthy":
    case "starting":
    case "unhealthy":
      return health;
    default:
      return "invalid";
  }
};

const statusFromProbeValue = (value: unknown): ServiceRuntimeInfo["status"] | undefined => {
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined;
  return typeof value.status === "string" ? value.status : undefined;
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
  });

const unavailableFromProbe = (
  ctx: ProviderErrorContext,
  input: {
    readonly service: string;
    readonly attempts: number;
    readonly elapsedMs: number;
    readonly outcome: "green" | "yellow" | "red";
    readonly lastHealth?: ServiceRuntimeInfo["health"];
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
      ...(input.lastError === undefined ? {} : { lastError: redactDetails(input.lastError) }),
    },
  });

export const waitForServiceHealth = (
  plan: AppPlan,
  target: ServiceSelector,
  options: WaitForServiceHealthOptions,
): Effect.Effect<ServiceRuntimeInfo, ProviderError> =>
  Effect.gen(function* () {
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
          success: (value) => {
            const health = healthFromProbeValue(value);
            if (statusFromProbeValue(value) === "running" && (health === "healthy" || health === undefined)) {
              return "green";
            }
            if (health === "starting") return "yellow";
            return "red";
          },
          failure: () => "red",
        },
      },
      attempt,
    ).pipe(
      Effect.mapError((cause) =>
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
        ...(info?.health === undefined ? {} : { lastHealth: info.health }),
        ...(result.lastError === undefined ? {} : { lastError: result.lastError }),
      }),
    );
  });
