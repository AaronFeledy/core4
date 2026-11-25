import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ContainerDisposition,
  LANDO_DATA_ROOT_LABEL,
  type ServicePlan,
} from "@lando/sdk/schema";
import type {
  BringDownOutcome,
  ObservedBringDown,
  ProviderError,
  ServiceRuntimeIdentity,
  ServiceRuntimeInfo,
  ServiceSelector,
} from "@lando/sdk/services";
import { Effect } from "effect";
import { type AdoptionReceipt, dataRootRefusal, decideDataRootOwnership } from "./data-root-ownership.ts";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi, missingService } from "./engine-errors.ts";
import { decodeNativeObservation, serviceContainerOwnershipProblem } from "./native-ownership.ts";
import { serviceContainerName } from "./plan.ts";
import { redactDetails, redactorFor, withApiReason } from "./redact.ts";
import { absentShutdown } from "./shutdown-observation.ts";
import { bringDownContainer } from "./stop-container.ts";

export type ServiceLifecycleAction = "start" | "stop" | "restart";

export interface ServiceLifecycleOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

export type ExactServiceLifecycleAction = "start" | "stop";

const containerName = (plan: AppPlan, service: ServicePlan): string =>
  serviceContainerName(plan, service.name);

const lifecycleRequest = (
  response: ReturnType<NonNullable<EngineHttpApi["request"]>>,
  ctx: ProviderErrorContext,
  input: {
    readonly operation: string;
    readonly requestAction: string;
    readonly failureAction: string;
    readonly details: {
      readonly service: ServiceSelector["service"];
      readonly containerId?: string;
    };
    readonly accepted: ReadonlyArray<number>;
    readonly missing: Effect.Effect<boolean, ServiceNotFoundError>;
  },
): Effect.Effect<boolean, ProviderError> =>
  response.pipe(
    mapFailures(
      (cause) =>
        new ProviderUnavailableError({
          providerId: ctx.providerId,
          operation: input.operation,
          message: `provider-${ctx.providerId} ${input.requestAction} request failed.`,
          remediation: ctx.remediation,
          cause,
        }),
    ),
    Effect.flatMap((response): Effect.Effect<boolean, ProviderError> => {
      if (response.status === 404) return input.missing;
      if (input.accepted.includes(response.status)) return Effect.succeed(true);
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: ctx.providerId,
          operation: input.operation,
          message: withApiReason(
            `${input.failureAction} failed with HTTP ${response.status}.`,
            response,
            redactorFor(ctx),
          ),
          details: redactDetails({ ...input.details, body: response.body }, redactorFor(ctx)),
          remediation: ctx.remediation,
        }),
      );
    }),
  );

export const postServiceLifecycle = (
  plan: AppPlan,
  target: ServiceSelector,
  action: ServiceLifecycleAction,
  options: ServiceLifecycleOptions,
): Effect.Effect<void, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Effect.fail(missingService(options.ctx, target, action));
  }
  const request = options.api?.request;
  if (request === undefined) {
    return Effect.fail(
      missingApi(
        options.ctx,
        action,
        `provider-${options.ctx.providerId} ${action} requires a container engine API client.`,
      ),
    );
  }

  return lifecycleRequest(
    request({
      method: "POST",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/${action}`,
    }),
    options.ctx,
    {
      operation: action,
      requestAction: action,
      failureAction: `Container ${action}`,
      details: { service: service.name },
      accepted: [204, 304],
      missing: Effect.fail(
        new ServiceNotFoundError({
          providerId: options.ctx.providerId,
          operation: action,
          service: target.service,
          message: `Service ${target.service} was not found.`,
          remediation:
            "Add the missing service to the Landofile or correct the service name, then re-run the command.",
        }),
      ),
    },
  ).pipe(Effect.asVoid);
};

export const postExactServiceLifecycle = (
  target: ServiceSelector,
  identity: ServiceRuntimeIdentity,
  action: ExactServiceLifecycleAction,
  options: ServiceLifecycleOptions,
): Effect.Effect<void, ProviderError> => {
  const request = options.api?.request;
  if (request === undefined) {
    return Effect.fail(
      missingApi(
        options.ctx,
        action,
        `provider-${options.ctx.providerId} ${action} requires a container engine API client.`,
      ),
    );
  }
  return lifecycleRequest(
    request({ method: "POST", path: `/containers/${encodeURIComponent(identity.containerId)}/${action}` }),
    options.ctx,
    {
      operation: action,
      requestAction: `exact ${action}`,
      failureAction: `Exact container ${action}`,
      details: { service: target.service, containerId: identity.containerId },
      accepted: [204, 304],
      missing: Effect.fail(
        new ServiceNotFoundError({
          providerId: options.ctx.providerId,
          operation: action,
          service: target.service,
          message: `The inspected runtime for ${target.service} was not found.`,
          remediation:
            "Add the missing service to the Landofile or correct the service name, then re-run the command.",
        }),
      ),
    },
  ).pipe(Effect.asVoid);
};

const OBSERVED_OPERATION = "bringDownObserved";

/** Reads one container's live name and labels by native id; a missing container is `undefined`. */
const liveContainer = Effect.fnUntraced(function* (
  observed: ServiceRuntimeInfo,
  containerId: string,
  runtime: { readonly request: NonNullable<EngineHttpApi["request"]>; readonly ctx: ProviderErrorContext },
) {
  const { request, ctx } = runtime;
  const response = yield* request({
    method: "GET",
    path: `/containers/${encodeURIComponent(containerId)}/json`,
  });
  if (response.status === 404) return undefined;
  const live = response.status === 200 ? decodeNativeObservation(response.body) : undefined;
  if (live === undefined)
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: ctx.providerId,
        operation: OBSERVED_OPERATION,
        message: withApiReason(
          `Container ${containerId} could not be inspected before bringing it down (HTTP ${response.status}).`,
          response,
          redactorFor(ctx),
        ),
        details: { service: observed.service, containerId },
        remediation: ctx.remediation,
      }),
    );
  const name = live.Name ?? live.name;
  return {
    nativeName: name === undefined ? undefined : name.replace(/^\//u, ""),
    labels: live.Config?.Labels ?? live.Labels ?? live.labels ?? undefined,
  };
});

/**
 * Stops, or stops and removes, the one container behind an observation the provider itself
 * reported, without consulting any applied plan. The container id is the whole address: a name could
 * be reused by a recreated container, and an observation carrying no id is a service the provider
 * already found nothing for, which is an absent receipt rather than an error. The observation never
 * authorizes the mutation: the container's live labels, read by id, must prove the observed app,
 * root, service, provider, and data root first.
 */
export const bringDownObservedContainer = Effect.fnUntraced(function* (
  observed: ServiceRuntimeInfo,
  containers: ContainerDisposition,
  options: ServiceLifecycleOptions & {
    readonly dataRoot?: string | undefined;
    readonly receipts?: readonly AdoptionReceipt[];
  },
): Effect.fn.Return<ObservedBringDown, ProviderError> {
  const operation = OBSERVED_OPERATION;
  const verb = containers === "stop" ? "stop" : "remove";
  if (String(observed.providerId) !== options.ctx.providerId)
    return yield* new ProviderUnavailableError({
      providerId: options.ctx.providerId,
      operation,
      message: `provider-${options.ctx.providerId} cannot ${verb} a container observed by ${observed.providerId}.`,
      details: { service: observed.service, observedProvider: observed.providerId },
      remediation: options.ctx.remediation,
    });
  const service = observed.service;
  const containerId = observed.containerId;
  const identity = {
    appId: observed.app,
    providerId: observed.providerId,
    service,
    ...(containerId === undefined ? {} : { containerId }),
  };
  const absent = { service, action: "absent", shutdownObservations: [absentShutdown(identity)] } as const;
  if (containerId === undefined) return absent;
  const request = options.api?.request;
  if (request === undefined)
    return yield* missingApi(
      options.ctx,
      operation,
      `provider-${options.ctx.providerId} ${operation} requires a container engine API client.`,
    );
  const live = yield* liveContainer(observed, containerId, { request, ctx: options.ctx });
  if (live === undefined) return absent;
  const native = {
    kind: "container",
    nativeName: live.nativeName ?? containerId,
    nativeId: containerId,
    labels: live.labels,
  } as const;
  if (
    options.dataRoot !== undefined &&
    decideDataRootOwnership(native, {
      dataRoot: options.dataRoot,
      receipts: live.nativeName === undefined ? [] : (options.receipts ?? []),
    }) !== "owned"
  )
    return yield* new ProviderUnavailableError({
      providerId: options.ctx.providerId,
      operation,
      ...dataRootRefusal(native),
      details: { service, containerId, label: LANDO_DATA_ROOT_LABEL },
    });
  const ownershipProblem = serviceContainerOwnershipProblem(live.labels, {
    app: String(observed.app),
    appRoot: observed.appRoot === undefined ? "" : String(observed.appRoot),
    service: String(service),
    dataRoot: options.dataRoot === undefined ? undefined : live.labels?.[LANDO_DATA_ROOT_LABEL],
    providerId: options.ctx.providerId,
  });
  if (ownershipProblem !== undefined)
    return yield* new ProviderUnavailableError({
      providerId: options.ctx.providerId,
      operation,
      message: `Container ${containerId} does not prove Lando service ownership: ${ownershipProblem} is missing or disagrees.`,
      details: { service, containerId, label: ownershipProblem },
      remediation: `Inspect container ${containerId} with your container runtime and ${verb} it there, or restore its ${ownershipProblem} label so it matches the observed app, root, and service.`,
    });
  const result = yield* bringDownContainer(identity, containers, { api: { request }, ctx: options.ctx });
  return { service, containerId, action: result.action, shutdownObservations: result.shutdownObservations };
});

/** The `bringDown` answer when the provider was handed no plan and holds no applied record. */
export const BRING_DOWN_NO_OP: BringDownOutcome = { kind: "no-op", reason: "no-applied-plan" };
