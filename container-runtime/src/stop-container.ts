import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type ContainerBringDownAction,
  type ContainerDisposition,
  ServiceShutdownObservation,
} from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import { removeRuntimeContainer } from "./container-removal.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { redactDetails, redactorFor, standaloneSecretsRedactor, withApiReason } from "./redact.ts";
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
    details: redactDetails({ shutdownObservations }, standaloneSecretsRedactor({})),
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

/** What one container bring-down did, with the shutdown facts observed before any removal. */
export interface ContainerBringDown {
  readonly changed: boolean;
  readonly action: ContainerBringDownAction;
  readonly shutdownObservations: readonly ServiceShutdownObservation[];
}

const absent = (identity: ShutdownIdentity): ContainerBringDown => ({
  changed: false,
  action: "absent",
  shutdownObservations: [absentShutdown(identity)],
});

/**
 * Stops one container by native id and keeps it. HTTP 404 is `absent` and 304 is `already-stopped`.
 * A stop the engine reported as failed still counts when inspection proves the container exited.
 */
export const stopContainer = Effect.fn("ContainerShutdown.stop")(function* (
  identity: ShutdownIdentity,
  options: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
): Effect.fn.Return<ContainerBringDown, ProviderInternalError | ProviderUnavailableError> {
  if (identity.containerId === undefined) return absent(identity);
  const request = options.api.request;
  if (request === undefined) return yield* Effect.fail(missingApi(options.ctx, "bringDown.stop"));
  const response = yield* request({
    method: "POST",
    path: `/containers/${encodeURIComponent(identity.containerId)}/stop`,
  });
  if (response.status === 404) return absent(identity);
  const stopped = response.status === 204 || response.status === 304;
  const inspected = observeShutdown({ ...identity, containerId: identity.containerId }, options);
  // A failed stop that still left the container exited has done its job: Podman records a container
  // whose monitor died as exited when its stop fails, so otherwise only a retry would succeed.
  const observation = stopped
    ? yield* inspected
    : yield* inspected.pipe(
        Effect.map((observed) => (observed.status === "exited" ? observed : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      );
  if (observation === undefined)
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
  const alreadyStopped = response.status === 304;
  return {
    changed: !alreadyStopped,
    action: alreadyStopped ? "already-stopped" : "stopped",
    shutdownObservations: [observation],
  };
});

/** Stops one container by native id, then removes it with its anonymous volumes. */
export const stopAndRemoveContainer = Effect.fn("ContainerShutdown.stopAndRemove")(function* (
  identity: ShutdownIdentity,
  options: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
): Effect.fn.Return<ContainerBringDown, ProviderInternalError | ProviderUnavailableError> {
  const stopped = yield* stopContainer(identity, options);
  if (stopped.action === "absent" || identity.containerId === undefined) return stopped;
  const shutdownObservations = stopped.shutdownObservations;
  const removed = yield* removeRuntimeContainer(options.api, identity.containerId, {
    ...options.ctx,
    operation: "bringDown.remove",
  }).pipe(mapFailures((error) => retainShutdownObservations(error, shutdownObservations)));
  return {
    changed: stopped.changed || removed,
    action: removed ? "removed" : "absent",
    shutdownObservations,
  };
});

/** Applies one container disposition: `stop` keeps the container, `remove` deletes it. */
export const bringDownContainer = (
  identity: ShutdownIdentity,
  containers: ContainerDisposition,
  options: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
) => (containers === "stop" ? stopContainer(identity, options) : stopAndRemoveContainer(identity, options));
