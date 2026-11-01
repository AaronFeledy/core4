import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type ObservedServiceRemoval, ServiceShutdownObservation } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import { removeRuntimeContainer } from "./container-removal.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { redactorFor, withApiReason } from "./redact.ts";
import { type ShutdownIdentity, absentShutdown, observeShutdown } from "./shutdown-observation.ts";

const FailureFacts = Schema.Struct({ shutdownObservations: Schema.Array(ServiceShutdownObservation) });

export const retainShutdownObservations = (
  error: ProviderInternalError | ProviderUnavailableError,
  observations: readonly ServiceShutdownObservation[],
): ProviderInternalError | ProviderUnavailableError => {
  if (observations.length === 0) return error;
  const existing = Schema.decodeUnknownOption(FailureFacts)(error.details);
  const shutdownObservations = [
    ...observations,
    ...(Option.isSome(existing) ? existing.value.shutdownObservations : []),
  ];
  const fields = {
    providerId: error.providerId,
    operation: error.operation,
    message: error.message,
    remediation: error.remediation,
    cause: error,
    details: { shutdownObservations },
  };
  switch (error._tag) {
    case "ProviderInternalError":
      return new ProviderInternalError(fields);
    case "ProviderUnavailableError":
      return new ProviderUnavailableError(fields);
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
};

export const stopAndRemoveContainer = Effect.fn("ContainerShutdown.stopAndRemove")(function* (
  identity: ShutdownIdentity,
  options: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
) {
  if (identity.containerId === undefined)
    return {
      changed: false,
      kind: "absent",
      shutdownObservations: [absentShutdown(identity)],
    } satisfies ObservedServiceRemoval & { readonly changed: boolean };
  const request = options.api.request;
  if (request === undefined) return yield* Effect.fail(missingApi(options.ctx, "bringDown.stop"));
  const response = yield* request({
    method: "POST",
    path: `/containers/${encodeURIComponent(identity.containerId)}/stop`,
  });
  if (response.status === 404)
    return {
      changed: false,
      kind: "absent",
      shutdownObservations: [absentShutdown(identity)],
    } satisfies ObservedServiceRemoval & { readonly changed: boolean };
  if (response.status !== 204 && response.status !== 304)
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: options.ctx.providerId,
        operation: "bringDown.stop",
        message: withApiReason(
          `Container stop failed with HTTP ${response.status}.`,
          response,
          redactorFor(options.ctx),
        ),
        remediation: options.ctx.remediation,
      }),
    );
  const observation = yield* observeShutdown({ ...identity, containerId: identity.containerId }, options);
  const shutdownObservations: readonly ServiceShutdownObservation[] = [observation];
  const removed = yield* removeRuntimeContainer(options.api, identity.containerId, {
    ...options.ctx,
    operation: "bringDown.remove",
  }).pipe(Effect.mapError((error) => retainShutdownObservations(error, shutdownObservations)));
  return {
    changed: response.status === 204 || removed,
    kind: removed ? "removed" : "absent",
    shutdownObservations,
  } satisfies ObservedServiceRemoval & { readonly changed: boolean };
});
