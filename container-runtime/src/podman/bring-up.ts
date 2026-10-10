import { type Context, DateTime, Duration, Effect, Stream } from "effect";
import { PROVIDER_LABEL, SCRATCH_ID_LABEL, SCRATCH_LABEL } from "../labels.ts";

import {
  ProviderInternalError,
  ProviderUnavailableError,
  type ServiceRestartWouldRecreateError,
  ServiceStartError,
  type ServiceStartLogTail,
} from "@lando/sdk/errors";
import { PostServiceStartEvent, PreServiceStartEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type AppRef,
  type EndpointPlan,
  type HostPlatform,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoAppNetworkName,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import type { ApplyOptions, ApplyResult, EventService } from "@lando/sdk/services";

import type { VolumeCreationFact } from "@lando/sdk/schema";
import { type LifecycleDialect, libpodLifecycleDialect } from "../dialect.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi, parseEngineJson } from "../engine-errors.ts";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  fingerprintInspectPublishPorts,
  fingerprintPlannedPublishPorts,
  serviceContainerName,
} from "../plan.ts";
import { redactDetails, redactString, withApiReason } from "../redact.ts";
import {
  type ServicePublishProbe,
  classifyServicePublishHost,
  copyInspectHostPorts,
  createAssignedHostPorts,
  isHostPortBindRejection,
  prepareCreatePublishEndpoints,
  shouldProbeServicePublishPort,
} from "../service-publish-ports.ts";
import { runServiceStartSchedule } from "../service-start-schedule.ts";
import { volumeCreationFact, volumeCreationLabels } from "../volume-creation.ts";
import { waitForExit } from "../wait-for-exit.ts";
import {
  bringUpRecreateReasons,
  inspectBindSources,
  inspectNetworkNames,
  makeServiceRestartWouldRecreateError,
} from "./bring-up-recreate.ts";
import { realizePodmanComposeKnobs } from "./compose-knobs.ts";
import { exec } from "./exec.ts";
import { logs } from "./logs.ts";
import { podmanNetworkNames } from "./networks.ts";

const appNetworkName = landoAppNetworkName;
const networkNames = podmanNetworkNames;
const serviceNetworkAliases = landoServiceNetworkAliases;
const sharedNetworkName = landoSharedNetworkName;

export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"];
  const scratchId = typeof scratch === "object" && scratch !== null ? Reflect.get(scratch, "id") : undefined;
  return scratchId === plan.id && typeof scratchId === "string"
    ? { [SCRATCH_LABEL]: "TRUE", [SCRATCH_ID_LABEL]: scratchId }
    : {};
};

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;
type BringUpError =
  | ServiceStartError
  | ServiceRestartWouldRecreateError
  | ProviderUnavailableError
  | ProviderInternalError;

/**
 * Neutral fallback used whenever a host has not installed a provider-specific
 * {@link BringUpOptions.startFailureRemediation} hook, or the hook declines a
 * failure by returning `undefined`.
 */
export const APPLY_REMEDIATION =
  "Run `lando destroy` to clean up any partial app state, then retry `lando start`. Run `lando doctor` if the failure persists.";

interface InspectResult {
  readonly exists: boolean;
  readonly running: boolean;
  readonly publishFingerprint: string;
  readonly bindSources: Readonly<Record<string, string>> | undefined;
  readonly networkNames: ReadonlyArray<string> | undefined;
  readonly body?: unknown;
}

interface StartResult {
  readonly changed: boolean;
}

/**
 * Provider-supplied remediation for a bring-up failure; `undefined` keeps the
 * neutral default. `service` is absent for app-scoped steps such as network
 * creation, whose failures still deserve provider-specific diagnosis.
 */
export type StartFailureRemediation = (input: {
  readonly service?: string;
  readonly operation: string;
  readonly message: string;
  readonly details?: unknown;
}) => string | undefined;

export interface BringUpOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly dialect?: LifecycleDialect;
  readonly ensureImage?: (input: {
    readonly service: ServicePlan;
    readonly ref: string;
    readonly force: boolean;
  }) => Effect.Effect<void, BringUpError>;
  readonly eventService?: EventPublisher;
  readonly retryCreateOnMissingImage?: boolean;
  readonly signal?: AbortSignal;
  readonly reconcile?: boolean;
  readonly startFailureRemediation?: StartFailureRemediation;
  readonly serviceEnvironment?: ApplyOptions["serviceEnvironment"];
  readonly platform?: HostPlatform;
  readonly daemonUrl?: string;
  readonly probeBind?: ServicePublishProbe;
  readonly forbidRecreate?: boolean;
}

interface BringUpDeps {
  readonly api: EngineHttpApi;
  readonly options: BringUpOptions;
}

interface StartFailureInput {
  readonly service: ServicePlan;
  readonly operation: string;
  readonly message: string;
  readonly details?: unknown;
  readonly cause?: unknown;
  readonly logTail?: ServiceStartLogTail;
}

const appRef = (plan: AppPlan): AppRef => ({
  kind: "user",
  id: plan.id,
  root: plan.root,
});

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

const containerRunning = (body: object): boolean => {
  const state = Reflect.get(body, "State");
  if (typeof state !== "object" || state === null) return false;
  return Reflect.get(state, "Running") === true || Reflect.get(state, "Status") === "running";
};

const podmanFailure = (deps: BringUpDeps, input: StartFailureInput) => {
  const message = withApiReason(input.message, input.details);
  const remediation =
    deps.options.startFailureRemediation?.({
      service: String(input.service.name),
      operation: input.operation,
      message,
      ...(input.details === undefined ? {} : { details: input.details }),
    }) ?? APPLY_REMEDIATION;
  return new ServiceStartError({
    providerId: input.service.provider,
    operation: input.operation,
    service: input.service.name,
    message,
    remediation,
    ...(input.details === undefined ? {} : { details: redactDetails(input.details) }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    ...(input.logTail === undefined ? {} : { logTail: input.logTail }),
  });
};

const request = (
  deps: BringUpDeps,
  input: EngineHttpRequest,
): Effect.Effect<EngineHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  deps.api.request === undefined
    ? Effect.fail(missingApi(deps.options.ctx, "bringUp"))
    : deps.api.request(input);

const inspectContainer = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  name: string,
): Effect.fn.Return<InspectResult, ProviderUnavailableError | ProviderInternalError> {
  const response = yield* request(deps, {
    method: "GET",
    path: `/containers/${encodeURIComponent(name)}/json`,
  });
  if (response.status === 404) {
    return {
      exists: false,
      running: false,
      publishFingerprint: "",
      bindSources: undefined,
      networkNames: undefined,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: deps.options.ctx.providerId,
        operation: "bringUp.inspect",
        message: withApiReason(
          `provider-${deps.options.ctx.providerId} inspect failed with HTTP ${response.status}.`,
          {
            status: response.status,
            body: response.body,
          },
        ),
        details: redactDetails({ name, status: response.status, body: response.body }),
        remediation: APPLY_REMEDIATION,
      }),
    );
  }
  const body = yield* parseEngineJson(response, deps.options.ctx, "bringUp.inspect", {
    details: redactDetails({ status: response.status, body: response.body }),
    remediation: APPLY_REMEDIATION,
  });
  if (typeof body !== "object" || body === null || !("State" in body)) {
    return {
      exists: true,
      running: false,
      publishFingerprint: fingerprintInspectPublishPorts(body),
      bindSources: inspectBindSources(body),
      networkNames: inspectNetworkNames(body),
      body,
    };
  }
  return {
    exists: true,
    running: containerRunning(body),
    publishFingerprint: fingerprintInspectPublishPorts(body),
    bindSources: inspectBindSources(body),
    networkNames: inspectNetworkNames(body),
    body,
  };
});

const hostConfig = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  endpoints: ReadonlyArray<EndpointPlan>,
) => {
  return containerHostConfigFragment(plan, service, {
    endpoints,
    onMissingBindMountSource: (mount) => {
      throw podmanFailure(deps, {
        service,
        operation: "bringUp.mount",
        message: `provider-${deps.options.ctx.providerId} bind mounts require a source.`,
        details: { mount },
      });
    },
  });
};

const createContainerRequest = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  endpoints: ReadonlyArray<EndpointPlan>,
) => {
  const knobs = realizePodmanComposeKnobs(service, {
    onInvalid: (message, details) => {
      throw podmanFailure(deps, { service, operation: "bringUp.knobs", message, details });
    },
  });
  const baseHostConfig = hostConfig(deps, plan, service, endpoints);
  const mountTargets = new Set<string>();
  const binds = baseHostConfig.Binds;
  if (Array.isArray(binds)) {
    for (const bind of binds) {
      if (typeof bind !== "string") continue;
      const withoutOptions = bind.endsWith(":ro") ? bind.slice(0, -3) : bind;
      const separator = withoutOptions.lastIndexOf(":");
      if (separator >= 0) mountTargets.add(withoutOptions.slice(separator + 1));
    }
  }
  const mounts = baseHostConfig.Mounts;
  if (Array.isArray(mounts)) {
    for (const mount of mounts) {
      if (typeof mount !== "object" || mount === null) continue;
      const target = Reflect.get(mount, "Target");
      if (typeof target === "string") mountTargets.add(target);
    }
  }
  const tmpfs = knobs.hostConfig.Tmpfs;
  if (typeof tmpfs === "object" && tmpfs !== null && !Array.isArray(tmpfs)) {
    const collision = Object.keys(tmpfs).find((target) => mountTargets.has(target));
    if (collision !== undefined) {
      throw podmanFailure(deps, {
        service,
        operation: "bringUp.knobs",
        message: "Compose tmpfs destination conflicts with a planned container mount.",
        details: { knob: "tmpfs", target: collision },
      });
    }
  }
  const body = {
    ...containerCreateBodyFragment(plan, service, {
      name,
      labels: commonContainerLabels(plan, service, scratchLabelsForPlan(plan)),
      hostConfig: {
        ...baseHostConfig,
        ...knobs.hostConfig,
      },
      networkingConfig: {
        EndpointsConfig:
          (deps.options.dialect ?? libpodLifecycleDialect).sharedNetworkAttachment === "connect-after-create"
            ? { [appNetworkName(plan)]: { Aliases: [service.name] } }
            : Object.fromEntries(
                networkNames(plan).map((name) => [
                  name,
                  name === sharedNetworkName(plan)
                    ? { Aliases: serviceNetworkAliases(plan, service) }
                    : { Aliases: [service.name] },
                ]),
              ),
      },
      onMissingArtifact: (artifact) => {
        throw podmanFailure(deps, {
          service,
          operation: "bringUp.artifact",
          message: `provider-${deps.options.ctx.providerId} bringUp requires pre-built artifact references.`,
          details: { artifact },
        });
      },
      ...(deps.options.serviceEnvironment?.[service.name] === undefined
        ? {}
        : { environment: deps.options.serviceEnvironment[service.name] }),
    }),
    ...knobs.topLevel,
  };
  const searchParams = new URLSearchParams({ name, ...knobs.query });
  const path: EngineHttpRequest["path"] = `/containers/create?${searchParams.toString()}`;
  return { body, path };
};

const ensureNetwork = (
  deps: BringUpDeps,
  name: string,
): Effect.Effect<boolean, ProviderUnavailableError | ProviderInternalError> => {
  return request(deps, { method: "GET", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((inspectResponse) => {
      if (inspectResponse.status === 200) {
        return Effect.succeed(false);
      }
      return request(deps, {
        method: "POST",
        path: "/networks/create",
        body: { Name: name, Driver: "bridge" },
      }).pipe(
        Effect.flatMap((response) => {
          if (response.status === 201 || response.status === 200) {
            return Effect.succeed(true);
          }
          if (response.status === 409) {
            return Effect.succeed(false);
          }
          const details = { status: response.status, body: response.body };
          const message = withApiReason(
            `provider-${deps.options.ctx.providerId} network create failed with HTTP ${response.status}.`,
            details,
          );
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: deps.options.ctx.providerId,
              operation: "bringUp.network",
              message,
              details: redactDetails(details),
              remediation:
                deps.options.startFailureRemediation?.({
                  operation: "bringUp.network",
                  message,
                  details,
                }) ?? APPLY_REMEDIATION,
            }),
          );
        }),
      );
    }),
  );
};

export const podmanVolumeCreationLabels = (
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Readonly<Record<string, string>> => ({
  ...volumeCreationLabels(plan, store),
  [PROVIDER_LABEL]: plan.provider,
});

const ensureVolume = (
  deps: BringUpDeps,
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Effect.Effect<readonly VolumeCreationFact[], ProviderUnavailableError | ProviderInternalError> => {
  const labels = podmanVolumeCreationLabels(plan, store);
  return request(deps, {
    method: "POST",
    path: "/volumes/create",
    body: {
      Name: store.name,
      Labels: labels,
    },
  }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 201 || response.status === 200)
        return Effect.succeed(volumeCreationFact({ body: response.body, name: store.name, labels }));
      if (response.status === 409) return Effect.succeed([]);
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: deps.options.ctx.providerId,
          operation: "bringUp.volume",
          message: withApiReason(
            `provider-${deps.options.ctx.providerId} volume create failed with HTTP ${response.status}.`,
            {
              status: response.status,
              body: response.body,
            },
          ),
          details: redactDetails({ name: store.name, status: response.status, body: response.body }),
          remediation: APPLY_REMEDIATION,
        }),
      );
    }),
  );
};

export const isMissingImageCreateResponse = (response: EngineHttpResponse): boolean =>
  response.status === 404 || /no such image/iu.test(response.body);

const buildCreateRequest = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  endpoints: ReadonlyArray<EndpointPlan>,
) =>
  Effect.try({
    try: () => createContainerRequest(deps, plan, service, name, endpoints),
    catch: (cause) =>
      cause instanceof ServiceStartError
        ? cause
        : podmanFailure(deps, {
            service,
            operation: "bringUp.create",
            message: `Failed to build provider-${deps.options.ctx.providerId} container create payload.`,
            cause,
          }),
  });

const createContainer = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  endpoints: ReadonlyArray<EndpointPlan>,
  reassign: (exclude: ReadonlySet<number>) => Effect.Effect<ReadonlyArray<EndpointPlan>, BringUpError>,
): Effect.fn.Return<ReadonlyArray<EndpointPlan>, BringUpError> {
  if (service.artifact?.kind === "ref" && deps.options.ensureImage !== undefined) {
    yield* deps.options.ensureImage({ service, ref: service.artifact.ref, force: false });
  }
  let createRequest = yield* buildCreateRequest(deps, plan, service, name, endpoints);
  const response = yield* request(deps, { method: "POST", ...createRequest });
  if (response.status === 201 || response.status === 409) return endpoints;
  if (
    deps.options.retryCreateOnMissingImage === true &&
    deps.options.ensureImage !== undefined &&
    service.artifact?.kind === "ref" &&
    isMissingImageCreateResponse(response)
  ) {
    yield* deps.options.ensureImage({ service, ref: service.artifact.ref, force: true });
    const retry = yield* request(deps, { method: "POST", ...createRequest });
    if (retry.status === 201 || retry.status === 409) return endpoints;
    if (!isHostPortBindRejection(retry)) {
      return yield* Effect.fail(
        podmanFailure(deps, {
          service,
          operation: "bringUp.create",
          message: `provider-${deps.options.ctx.providerId} container create failed with HTTP ${retry.status}.`,
          details: {
            status: response.status,
            body: response.body,
            retryStatus: retry.status,
            retryBody: retry.body,
          },
        }),
      );
    }
  } else if (!isHostPortBindRejection(response)) {
    return yield* Effect.fail(
      podmanFailure(deps, {
        service,
        operation: "bringUp.create",
        message: `provider-${deps.options.ctx.providerId} container create failed with HTTP ${response.status}.`,
        details: { status: response.status, body: response.body },
      }),
    );
  }
  if (deps.options.forbidRecreate === true) {
    return yield* Effect.fail(
      makeServiceRestartWouldRecreateError({
        providerId: String(service.provider),
        service: String(service.name),
        reason: "host-port",
        operation: "bringUp.create",
      }),
    );
  }
  const rebound = yield* reassign(createAssignedHostPorts(endpoints));
  createRequest = yield* buildCreateRequest(deps, plan, service, name, rebound);
  const bindRetry = yield* request(deps, { method: "POST", ...createRequest });
  if (bindRetry.status === 201 || bindRetry.status === 409) return rebound;
  return yield* Effect.fail(
    podmanFailure(deps, {
      service,
      operation: "bringUp.create",
      message: `provider-${deps.options.ctx.providerId} container create failed with HTTP ${bindRetry.status}.`,
      details: {
        status: response.status,
        body: response.body,
        retryStatus: bindRetry.status,
        retryBody: bindRetry.body,
      },
    }),
  );
});

const isAlreadyConnectedResponse = (response: EngineHttpResponse): boolean =>
  response.status === 403 && /already\s+(exists|connected)|endpoint.*exists|same name/iu.test(response.body);

const connectSharedNetwork = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  sharedNetwork: string,
): Effect.Effect<void, BringUpError> =>
  request(deps, {
    method: "POST",
    path: `/networks/${encodeURIComponent(sharedNetwork)}/connect`,
    body: {
      Container: name,
      EndpointConfig: { Aliases: serviceNetworkAliases(plan, service) },
    },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ||
      response.status === 201 ||
      response.status === 204 ||
      response.status === 409 ||
      isAlreadyConnectedResponse(response)
        ? Effect.void
        : Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.network.connect",
              message: `provider-${deps.options.ctx.providerId} network connect failed with HTTP ${response.status}.`,
              details: { status: response.status, body: response.body },
            }),
          ),
    ),
  );

const startContainer = (deps: BringUpDeps, name: string): Effect.Effect<EngineHttpResponse, BringUpError> =>
  request(deps, { method: "POST", path: `/containers/${encodeURIComponent(name)}/start` });

const stopContainerSilent = (deps: BringUpDeps, name: string): Effect.Effect<void> =>
  request(deps, { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.catch(() => Effect.void),
  );

const removeContainerSilent = (deps: BringUpDeps, name: string): Effect.Effect<void> =>
  request(deps, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.catch(() => Effect.void),
  );

const removeContainer = (
  deps: BringUpDeps,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  request(deps, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.flatMap((response) =>
      response.status === 204 || response.status === 200 || response.status === 404
        ? Effect.void
        : Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.remove",
              message: `provider-${deps.options.ctx.providerId} container remove failed with HTTP ${response.status}.`,
              details: { status: response.status, body: response.body },
            }),
          ),
    ),
  );

const removeNetworkSilent = (deps: BringUpDeps, plan: AppPlan): Effect.Effect<void> =>
  request(deps, {
    method: "DELETE",
    path: `/networks/${encodeURIComponent(appNetworkName(plan))}`,
  }).pipe(Effect.catch(() => Effect.void));

const removeCreatedNetworksSilent = (
  deps: BringUpDeps,
  createdNetworks: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    createdNetworks,
    (name) =>
      request(deps, {
        method: "DELETE",
        path: `/networks/${encodeURIComponent(name)}`,
      }).pipe(Effect.catch(() => Effect.void)),
    { discard: true },
  );

const publish = (
  deps: BringUpDeps,
  event: Parameters<EventPublisher["publish"]>[0],
): Effect.Effect<void, ProviderInternalError> =>
  deps.options.eventService === undefined
    ? Effect.void
    : deps.options.eventService.publish(event).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInternalError({
              providerId: deps.options.ctx.providerId,
              operation: "bringUp.event",
              message: `Failed to publish lifecycle event: ${event._tag}`,
              remediation: APPLY_REMEDIATION,
              cause,
            }),
        ),
      );

const startService = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  recordTouched: (container: TouchedContainer) => void,
): Effect.fn.Return<StartResult, BringUpError> {
  const name = containerName(plan, service);
  const providerId = ProviderId.make(deps.options.ctx.providerId);

  if (deps.options.signal?.aborted === true) {
    yield* Effect.fail(
      podmanFailure(deps, {
        service,
        operation: "bringUp",
        message: `provider-${deps.options.ctx.providerId} bringUp was cancelled before service start.`,
      }),
    );
  }

  yield* publish(
    deps,
    PreServiceStartEvent.make({
      eventName: "pre-service-start",
      appRef: appRef(plan),
      serviceName: service.name,
      providerId,
      timestamp: yield* DateTime.now,
    }),
  );

  const inspected = yield* inspectContainer(deps, name);
  if (!inspected.exists && deps.options.forbidRecreate === true) {
    return yield* Effect.fail(
      new ServiceStartError({
        providerId: deps.options.ctx.providerId,
        operation: "bringUp",
        service: service.name,
        message: `Cannot restart ${service.name} in place because its container is missing.`,
        remediation: `Run \`lando rebuild -s ${service.name}\` to create this service.`,
      }),
    );
  }
  const published = service.endpoints.flatMap((endpoint) =>
    endpoint._tag === "published" ? [endpoint] : [],
  );
  const plannedFingerprint = fingerprintPlannedPublishPorts(published);
  const portMismatch =
    plannedFingerprint.length > 0 &&
    inspected.publishFingerprint.length > 0 &&
    inspected.publishFingerprint !== plannedFingerprint;
  const recreateReasons = bringUpRecreateReasons(plan, service, inspected);
  let before = inspected;
  if (before.exists && (deps.options.reconcile === true || recreateReasons.length > 0)) {
    if (deps.options.forbidRecreate === true && recreateReasons.length > 0) {
      return yield* Effect.fail(
        makeServiceRestartWouldRecreateError({
          providerId: String(service.provider),
          service: String(service.name),
          reason: recreateReasons[0] ?? "publish-port",
          operation: "bringUp",
        }),
      );
    }
    yield* stopContainerSilent(deps, name);
    yield* removeContainer(deps, service, name);
    before = {
      exists: false,
      running: false,
      publishFingerprint: "",
      bindSources: undefined,
      networkNames: undefined,
    };
  }
  recordTouched({
    name,
    created: !before.exists,
    startedExisting: before.exists && !before.running,
  });
  const publishHost = classifyServicePublishHost({
    platform: deps.options.platform ?? process.platform,
    ...(deps.options.daemonUrl === undefined ? {} : { daemonUrl: deps.options.daemonUrl }),
  });
  const prepareEndpoints = (exclude?: ReadonlySet<number>) =>
    prepareCreatePublishEndpoints({
      endpoints: service.endpoints,
      ...(inspected.body === undefined ? {} : { inspect: inspected.body }),
      copyInspectHostPort: exclude === undefined && inspected.exists && !before.exists && !portMismatch,
      host: publishHost,
      ...(deps.options.probeBind === undefined ? {} : { probeBind: deps.options.probeBind }),
      ...(exclude === undefined ? {} : { exclude }),
    });
  let changed = false;
  const inspectedBindings =
    typeof inspected.body === "object" && inspected.body !== null && "HostConfig" in inspected.body
      ? { HostConfig: inspected.body.HostConfig }
      : undefined;
  let createEndpoints =
    before.exists && shouldProbeServicePublishPort(publishHost)
      ? copyInspectHostPorts(service.endpoints, inspectedBindings)
      : service.endpoints;
  if (!before.exists) {
    createEndpoints = yield* prepareEndpoints();
    createEndpoints = yield* createContainer(deps, plan, service, name, createEndpoints, prepareEndpoints);
    changed = true;
  }
  const sharedNetwork = sharedNetworkName(plan);
  if (
    (deps.options.dialect ?? libpodLifecycleDialect).sharedNetworkAttachment === "connect-after-create" &&
    sharedNetwork !== undefined
  ) {
    yield* connectSharedNetwork(deps, plan, service, name, sharedNetwork);
  }
  if (!before.running) {
    const response = yield* startContainer(deps, name);
    if (response.status !== 204 && response.status !== 304) {
      const assigned = createAssignedHostPorts(
        createEndpoints.filter((_endpoint, index) => {
          const desired = service.endpoints[index];
          return desired?._tag === "published" && desired.publication.hostPort === undefined;
        }),
      );
      let retry: EngineHttpResponse | undefined;
      if (isHostPortBindRejection(response) && assigned.size > 0) {
        if (deps.options.forbidRecreate === true) {
          return yield* Effect.fail(
            makeServiceRestartWouldRecreateError({
              providerId: String(service.provider),
              service: String(service.name),
              reason: "host-port",
              operation: "bringUp.start",
            }),
          );
        }
        yield* stopContainerSilent(deps, name);
        yield* removeContainer(deps, service, name);
        recordTouched({ name, created: true, startedExisting: false });
        createEndpoints = yield* prepareEndpoints(assigned);
        yield* createContainer(deps, plan, service, name, createEndpoints, prepareEndpoints);
        if (
          (deps.options.dialect ?? libpodLifecycleDialect).sharedNetworkAttachment ===
            "connect-after-create" &&
          sharedNetwork !== undefined
        ) {
          yield* connectSharedNetwork(deps, plan, service, name, sharedNetwork);
        }
        retry = yield* startContainer(deps, name);
      }
      if (retry === undefined || (retry.status !== 204 && retry.status !== 304)) {
        return yield* Effect.fail(
          podmanFailure(deps, {
            service,
            operation: "bringUp.start",
            message: `provider-${deps.options.ctx.providerId} container start failed with HTTP ${retry?.status ?? response.status}.`,
            details: {
              status: response.status,
              body: response.body,
              ...(retry === undefined ? {} : { retryStatus: retry.status, retryBody: retry.body }),
            },
          }),
        );
      }
    }
    changed = true;
  }

  const after = yield* inspectContainer(deps, name);
  if (!after.running) {
    yield* Effect.fail(
      podmanFailure(deps, {
        service,
        operation: "bringUp.start",
        message: `provider-${deps.options.ctx.providerId} container did not reach running state.`,
      }),
    );
  }

  yield* publish(
    deps,
    PostServiceStartEvent.make({
      eventName: "post-service-start",
      appRef: appRef(plan),
      serviceName: service.name,
      providerId,
      timestamp: yield* DateTime.now,
    }),
  );

  return { changed };
});

interface TouchedContainer {
  readonly name: string;
  readonly created: boolean;
  readonly startedExisting: boolean;
}

const cleanupTouchedContainers = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  touched: ReadonlyArray<TouchedContainer>,
): Effect.fn.Return<void> {
  yield* Effect.forEach(
    touched.filter((container) => container.created || container.startedExisting),
    (container) => stopContainerSilent(deps, container.name),
    { discard: true },
  );
  yield* Effect.forEach(
    touched.filter((container) => container.created),
    (container) => removeContainerSilent(deps, container.name),
    { discard: true },
  );
});

const rollbackPartialApply = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  touched: ReadonlyArray<TouchedContainer>,
  createdNetworks: ReadonlySet<string>,
): Effect.fn.Return<void> {
  // Volumes are preserved so rollback does not discard persistent data.
  yield* cleanupTouchedContainers(deps, touched);
  if (deps.options.forbidRecreate !== true) yield* removeNetworkSilent(deps, plan);
  yield* removeCreatedNetworksSilent(deps, createdNetworks);
});

const SERVICE_START_LOG_TAIL_LINES = 50;
const SERVICE_START_LOG_TAIL_MAX_CHARS = 4000;
const SERVICE_START_LOG_TAIL_TIMEOUT = Duration.seconds(4);

const capRedactedLogLines = (
  lines: ReadonlyArray<string>,
): { readonly lines: string[]; readonly truncated: boolean } => {
  const redacted = lines.map((line) => redactString(line));
  const kept: string[] = [];
  let used = 0;
  for (const line of redacted) {
    const extra = kept.length === 0 ? line.length : line.length + 1;
    if (used + extra > SERVICE_START_LOG_TAIL_MAX_CHARS) {
      return { lines: kept, truncated: true };
    }
    kept.push(line);
    used += extra;
  }
  return { lines: kept, truncated: false };
};

const captureServiceLogTail = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  extras?: { readonly exitCode?: number; readonly timedOut?: boolean },
): Effect.fn.Return<ServiceStartLogTail | undefined> {
  const collected = yield* Stream.runCollect(
    logs(
      plan,
      { app: plan.id, service: service.name },
      { follow: false, tail: SERVICE_START_LOG_TAIL_LINES, sources: [] },
      { api: deps.api, ctx: deps.options.ctx },
    ),
  ).pipe(
    Effect.timeout(SERVICE_START_LOG_TAIL_TIMEOUT),
    Effect.orElseSucceed(() => undefined),
  );
  if (collected === undefined) return undefined;
  const raw = [...collected].map((chunk) => chunk.line);
  if (raw.length === 0) return undefined;
  const { lines, truncated } = capRedactedLogLines(raw);
  if (lines.length === 0) return undefined;
  return {
    service: String(service.name),
    lines,
    truncated,
    ...(extras?.exitCode === undefined ? {} : { exitCode: extras.exitCode }),
    ...(extras?.timedOut === true ? { timedOut: true } : {}),
  };
});

const withServiceStartLogTail = (
  error: ServiceStartError,
  logTail: ServiceStartLogTail | undefined,
): ServiceStartError =>
  logTail === undefined
    ? error
    : new ServiceStartError({
        providerId: error.providerId,
        operation: error.operation,
        message: error.message,
        service: error.service,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
        ...(error.cause === undefined ? {} : { cause: error.cause }),
        logTail,
      });

const rollbackAfterStartFailure = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  touched: ReadonlyArray<TouchedContainer>,
  createdNetworks: ReadonlySet<string>,
  error: BringUpError,
): Effect.fn.Return<never, BringUpError> {
  if (deps.options.signal?.aborted === true) {
    return yield* Effect.interrupt;
  }
  if (error instanceof ServiceStartError) {
    const named = plan.services[ServiceName.make(error.service)];
    const logTail = named === undefined ? undefined : yield* captureServiceLogTail(deps, plan, named);
    yield* rollbackPartialApply(deps, plan, touched, createdNetworks);
    return yield* Effect.fail(withServiceStartLogTail(error, logTail));
  }
  yield* rollbackPartialApply(deps, plan, touched, createdNetworks);
  return yield* Effect.fail(error);
});

export const bringUp = Effect.fn("RuntimeProvider.bringUp")(function* (
  plan: AppPlan,
  options: BringUpOptions,
): Effect.fn.Return<ApplyResult, BringUpError> {
  const api = options.api;
  if (api?.request === undefined) {
    return yield* Effect.fail(missingApi(options.ctx, "bringUp"));
  }
  if (options.forbidRecreate === true && options.reconcile === true) {
    return yield* Effect.fail(
      new ProviderInternalError({
        providerId: options.ctx.providerId,
        operation: "bringUp",
        message: "forbidRecreate cannot be combined with reconcile.",
        remediation: "Omit reconcile when forbidding recreate, or omit forbidRecreate when reconciling.",
      }),
    );
  }
  const deps: BringUpDeps = { api, options };

  const createdNetworks = new Set<string>();
  for (const name of networkNames(plan)) {
    if (yield* ensureNetwork(deps, name)) {
      createdNetworks.add(name);
    }
  }
  const createdVolumes: VolumeCreationFact[] = [];
  for (const store of plan.stores) {
    createdVolumes.push(...(yield* ensureVolume(deps, plan, store)));
  }
  const touched: TouchedContainer[] = [];
  const result = yield* runServiceStartSchedule(plan, {
    startService: Effect.fnUntraced(function* (service) {
      if (options.signal?.aborted === true) {
        return yield* Effect.interrupt;
      }
      const started = yield* startService(deps, plan, service, (container) => {
        // Recovery replaces the touched record so rollback removes the recreation exactly once.
        const index = touched.findIndex((entry) => entry.name === container.name);
        if (index === -1) touched.push(container);
        else touched[index] = container;
      }).pipe(
        Effect.catch((error) => (options.signal?.aborted === true ? Effect.interrupt : Effect.fail(error))),
      );
      return { changed: started.changed };
    }),
    cleanupOptionalStartFailure: Effect.fnUntraced(function* (service) {
      const name = containerName(plan, service);
      const index = touched.findIndex((container) => container.name === name);
      const container = touched[index];
      if (container === undefined) return;
      yield* cleanupTouchedContainers(deps, [container]);
      touched.splice(index, 1);
    }),
    execHealthcheck: (service, command) =>
      exec(
        plan,
        { app: plan.id, service: service.name },
        { command, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        { api, ctx: options.ctx },
      ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
    waitForExit: (service) =>
      waitForExit(
        plan,
        { app: plan.id, service: service.name },
        {
          api,
          ctx: options.ctx,
          dialect: (options.dialect ?? libpodLifecycleDialect).wait,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
  }).pipe(
    Effect.catch((error) => rollbackAfterStartFailure(deps, plan, touched, createdNetworks, error)),
    Effect.onInterrupt(() => rollbackPartialApply(deps, plan, touched, createdNetworks)),
  );

  if (result._tag === "Cycle") {
    yield* rollbackPartialApply(deps, plan, touched, createdNetworks);
    return yield* Effect.fail(
      new ProviderInternalError({
        providerId: options.ctx.providerId,
        operation: "bringUp.schedule",
        message: `provider-${options.ctx.providerId} bringUp service schedule contains a dependency cycle.`,
        remediation: APPLY_REMEDIATION,
        details: redactDetails({ edges: result.edges }),
      }),
    );
  }
  const [blocked] = result.blocked;
  if (blocked !== undefined) {
    const service = plan.services[ServiceName.make(blocked.service)];
    const dependency = plan.services[ServiceName.make(blocked.dependency)];
    const logTail =
      dependency === undefined
        ? undefined
        : yield* captureServiceLogTail(deps, plan, dependency, {
            ...(blocked.lastExitCode === undefined ? {} : { exitCode: blocked.lastExitCode }),
            ...(blocked.timedOut === true ? { timedOut: true } : {}),
          });
    yield* rollbackPartialApply(deps, plan, touched, createdNetworks);
    if (service === undefined) {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.ctx.providerId,
          operation: "bringUp.schedule",
          message: `provider-${options.ctx.providerId} bringUp schedule blocked an unknown service.`,
          remediation: APPLY_REMEDIATION,
          details: redactDetails(blocked),
        }),
      );
    }
    return yield* Effect.fail(
      podmanFailure(deps, {
        service,
        operation: "bringUp.schedule",
        message: `Service ${blocked.service} could not start because dependency gate ${blocked.unmetGate} was not satisfied.`,
        ...(logTail === undefined ? {} : { logTail }),
      }),
    );
  }

  return { changed: result.changed || createdVolumes.length > 0, createdVolumes };
});
