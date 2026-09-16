import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceExitResult, ServiceSelector } from "@lando/sdk/services";

import type { WaitDialect } from "./dialect.ts";
import type { EngineHttpApi, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { redactDetails, withApiReason } from "./redact.ts";

export interface WaitForExitOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly dialect: WaitDialect;
  readonly signal?: AbortSignal;
}

const containerName = (plan: AppPlan, service: ServicePlan): string =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const parseJson = (
  response: EngineHttpResponse,
  ctx: ProviderErrorContext,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: (): unknown => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: ctx.providerId,
        operation: "waitForExit",
        message: "Container engine API returned malformed JSON.",
        details: redactDetails(response),
        remediation: ctx.remediation,
        cause,
      }),
  });

export const waitForExit = (
  plan: AppPlan,
  target: ServiceSelector,
  options: WaitForExitOptions,
): Effect.Effect<ServiceExitResult, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Effect.fail(
      new ServiceNotFoundError({
        providerId: options.ctx.providerId,
        operation: "waitForExit",
        service: target.service,
        message: `Service ${target.service} is not present in the app plan.`,
      }),
    );
  }
  const request = options.api?.request;
  if (request === undefined) {
    return Effect.fail(
      missingApi(
        options.ctx,
        "waitForExit",
        `provider-${options.ctx.providerId} waitForExit requires a container engine API client.`,
      ),
    );
  }

  return Effect.gen(function* () {
    const response = yield* request(options.dialect.request(containerName(plan, service), options.signal));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: options.ctx.providerId,
          operation: "waitForExit",
          message: withApiReason(`Container wait failed with HTTP ${response.status}.`, response),
          details: redactDetails({ service: service.name, body: response.body }),
          remediation: options.ctx.remediation,
        }),
      );
    }

    const decoded = yield* parseJson(response, options.ctx);
    const exitCode = options.dialect.decodeExitCode(decoded);
    if (exitCode === undefined) {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.ctx.providerId,
          operation: "waitForExit",
          message: "Container wait did not return a numeric container exit code.",
          details: { service: service.name },
          remediation: options.ctx.remediation,
        }),
      );
    }
    return { exitCode };
  });
};
