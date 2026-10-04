import { Effect } from "effect";
import { serviceContainerName } from "./plan.ts";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceExitResult, ServiceSelector } from "@lando/sdk/services";

import type { WaitDialect } from "./dialect.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi, parseEngineJson } from "./engine-errors.ts";
import { redactDetails, withApiReason } from "./redact.ts";

export interface WaitForExitOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly dialect: WaitDialect;
  readonly signal?: AbortSignal;
}

const containerName = (plan: AppPlan, service: ServicePlan): string =>
  serviceContainerName(plan, service.name);

export const waitForExit = Effect.fn("RuntimeProvider.waitForExit")(function* (
  plan: AppPlan,
  target: ServiceSelector,
  options: WaitForExitOptions,
): Effect.fn.Return<ServiceExitResult, ProviderError> {
  const service = plan.services[target.service];
  if (service === undefined) {
    return yield* Effect.fail(
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
    return yield* Effect.fail(
      missingApi(
        options.ctx,
        "waitForExit",
        `provider-${options.ctx.providerId} waitForExit requires a container engine API client.`,
      ),
    );
  }

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

  const decoded = yield* parseEngineJson(response, options.ctx, "waitForExit", {
    message: "Container engine API returned malformed JSON.",
    details: redactDetails(response),
  });
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
