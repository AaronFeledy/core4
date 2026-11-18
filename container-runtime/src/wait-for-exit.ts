import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceExitResult, ServiceSelector } from "@lando/sdk/services";
import { Effect } from "effect";
import type { WaitDialect } from "./dialect.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi, parseEngineJson } from "./engine-errors.ts";
import { interruptOnAbort } from "./healthcheck-attempt.ts";
import { serviceContainerName } from "./plan.ts";
import { redactDetails, redactResponseDetails, redactorFor, withApiReason } from "./redact.ts";

export interface WaitForExitOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly dialect: WaitDialect;
  readonly signal?: AbortSignal;
  readonly nativeId?: string;
}

/** Options for the verified-id native wait used by bring-up and public wait. */
export interface WaitNativeContainerOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly dialect: WaitDialect;
  readonly signal?: AbortSignal;
}

/**
 * Result of a native container wait against a verified engine id.
 * `Missing` is only for not-found at the wait endpoint; other failures stay on the error channel.
 */
export type NativeWaitResult =
  | { readonly _tag: "Returned"; readonly exitCode: number }
  | { readonly _tag: "Missing" };

const containerName = (plan: AppPlan, service: ServicePlan): string =>
  serviceContainerName(plan, service.name);

/**
 * Wait for a container identified by a verified engine id.
 * Signature: `waitNativeContainer(id, options) => Effect<NativeWaitResult, ProviderError>`
 * where NativeWaitResult is `{ _tag: "Returned"; exitCode: number } | { _tag: "Missing" }`.
 */
export const waitNativeContainer = Effect.fn("waitNativeContainer")(function* (
  id: string,
  options: WaitNativeContainerOptions,
): Effect.fn.Return<NativeWaitResult, ProviderError> {
  if (options.signal?.aborted === true) return yield* Effect.interrupt;
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

  const response = yield* interruptOnAbort(request(options.dialect.request(id)), options.signal);
  // Verified-id not-found at the known wait endpoint only — do not blanket-catch other 404s.
  if (response.status === 404) {
    return { _tag: "Missing" as const };
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: options.ctx.providerId,
        operation: "waitForExit",
        message: withApiReason(
          `Container wait failed with HTTP ${response.status}.`,
          response,
          redactorFor(options.ctx),
        ),
        details: redactDetails({ container: id, body: response.body }, redactorFor(options.ctx)),
        remediation: options.ctx.remediation,
      }),
    );
  }

  const decoded = yield* parseEngineJson(response, options.ctx, "waitForExit", {
    message: "Container engine API returned malformed JSON.",
    details: redactResponseDetails(response, redactorFor(options.ctx)),
  });
  const exitCode = options.dialect.decodeExitCode(decoded);
  if (exitCode === undefined) {
    return yield* Effect.fail(
      new ProviderInternalError({
        providerId: options.ctx.providerId,
        operation: "waitForExit",
        message: "Container wait did not return a numeric container exit code.",
        details: { container: id },
        remediation: options.ctx.remediation,
      }),
    );
  }
  return { _tag: "Returned" as const, exitCode };
});

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
        remediation:
          "Add the missing service to the Landofile or correct the service name, then re-run the command.",
      }),
    );
  }

  const result = yield* waitNativeContainer(options.nativeId ?? containerName(plan, service), {
    ctx: options.ctx,
    dialect: options.dialect,
    ...(options.api === undefined ? {} : { api: options.api }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result._tag === "Missing") {
    // Public boundary: Missing becomes a provider error; keep ServiceExitResult success shape.
    return yield* Effect.fail(
      new ServiceNotFoundError({
        providerId: options.ctx.providerId,
        operation: "waitForExit",
        service: target.service,
        message: `Service ${target.service} was not found.`,
        remediation:
          "Add the missing service to the Landofile or correct the service name, then re-run the command.",
      }),
    );
  }
  return { exitCode: result.exitCode };
});
