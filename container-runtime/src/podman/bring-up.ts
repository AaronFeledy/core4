import { Cause, type Context, DateTime, Duration, Effect, Option, Stream } from "effect";
import { PROVIDER_LABEL } from "../labels.ts";

import {
  EnvironmentValueResolutionError,
  PlanReplanRequiredError,
  ProviderInternalError,
  ProviderUnavailableError,
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
  type ServiceNetworkAttachment,
  type ServicePlan,
  landoAppNetworkName,
  landoExternalNetworkNames,
  landoServiceNetworkAttachments,
} from "@lando/sdk/schema";
import type { ApplyOptions, ApplyResult, EventService, ProviderError } from "@lando/sdk/services";

import type { VolumeCreationFact } from "@lando/sdk/schema";
import { removeRuntimeContainer } from "../container-removal.ts";
import { completionIntentServices } from "../dependency-gates.ts";
import { type LifecycleDialect, libpodLifecycleDialect } from "../dialect.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi, parseEngineJson } from "../engine-errors.ts";
import { literalServiceEnvironment, requireCurrentCreationPlan } from "../environment-values.ts";
import { prepareFileModeMounts } from "../file-mode-mounts.ts";
import {
  containerOwnershipLabels,
  inspectOwnedNativeId,
  isSharedNetwork,
  verifiedNativeId,
} from "../native-ownership.ts";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  fingerprintInspectPublishPorts,
  fingerprintPlannedPublishPorts,
  serviceContainerName,
} from "../plan.ts";
import { StartFailureLogRedactor, redactDetails, redactorFor, withApiReason } from "../redact.ts";
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
import { isServiceRestartExpected } from "../supervision.ts";
import { volumeCreationFact, volumeCreationLabels } from "../volume-creation.ts";
import { waitForExit } from "../wait-for-exit.ts";
import {
  ensureAuthoredNetwork,
  ensurePrivateNetwork,
  preflightExternalNetwork,
} from "./bring-up-networks.ts";
import {
  bringUpRecreateReasons,
  inspectBindSources,
  inspectContainerLabels,
  inspectNetworkNames,
  makeServiceRestartWouldRecreateError,
} from "./bring-up-recreate.ts";
import { realizePodmanComposeKnobs } from "./compose-knobs.ts";
import { type ExecOptions, exec } from "./exec.ts";
import { logs } from "./logs.ts";

export { scratchLabelsForPlan } from "../labels.ts";

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;
type BringUpError = ProviderError;

/**
 * Neutral fallback used whenever a host has not installed a provider-specific
 * {@link BringUpOptions.startFailureRemediation} hook, or the hook declines a
 * failure by returning `undefined`.
 */
export const APPLY_REMEDIATION =
  "Fix the reported error, then run `lando start`; it reuses what this attempt created. Run `lando doctor` if the failure persists.";

export const GLOBAL_APPLY_REMEDIATION =
  "Fix the error above, then run `lando global:start` to retry the global services. Run `lando doctor` if the failure persists.";

interface InspectResult {
  readonly exists: boolean;
  readonly running: boolean;
  readonly publishFingerprint: string;
  readonly bindSources: Readonly<Record<string, string>> | undefined;
  readonly networkNames: ReadonlyArray<string> | undefined;
  readonly labels?: Readonly<Record<string, string>>;
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
  readonly resolveContainerHelper?: ExecOptions["resolveContainerHelper"];
  readonly helperTarget?: ExecOptions["helperTarget"];
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
  readonly resolveServiceEnvironment?: ApplyOptions["resolveServiceEnvironment"];
  readonly onVolumeCreated?: ApplyOptions["onVolumeCreated"];
  readonly platform?: HostPlatform;
  readonly daemonUrl?: string;
  readonly probeBind?: ServicePublishProbe;
  readonly forbidRecreate?: boolean;
  readonly completionPlan?: AppPlan;
  readonly userDataRoot?: string | undefined;
}

interface BringUpDeps {
  readonly api: EngineHttpApi;
  readonly options: BringUpOptions;
  readonly remediation: string;
  readonly creationEnvironments: Map<string, Readonly<Record<string, string>>>;
  /** Cached once per bringUp; never construct per failure/inspect line. */
  readonly redactor: ReturnType<typeof redactorFor>;
}

const creationEligibility = (plan: AppPlan) =>
  Effect.try({
    try: () => requireCurrentCreationPlan(plan),
    catch: (error) => {
      if (error instanceof PlanReplanRequiredError) return error;
      throw error;
    },
  });

const prepareCreationEnvironment = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
): Effect.fn.Return<Readonly<Record<string, string>>, ProviderError> {
  const prepared = deps.creationEnvironments.get(service.name);
  if (prepared !== undefined) return prepared;
  yield* creationEligibility(plan);
  const environment = yield* deps.options.resolveServiceEnvironment === undefined
    ? Effect.try({
        try: () => literalServiceEnvironment(service),
        catch: (error) => {
          if (error instanceof EnvironmentValueResolutionError) return error;
          throw error;
        },
      })
    : deps.options.resolveServiceEnvironment(service);
  deps.creationEnvironments.set(service.name, environment);
  return environment;
});

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
  const redactor = deps.redactor;
  const message = withApiReason(input.message, input.details, redactor);
  const remediation =
    deps.options.startFailureRemediation?.({
      service: String(input.service.name),
      operation: input.operation,
      message,
      ...(input.details === undefined ? {} : { details: input.details }),
    }) ?? deps.remediation;
  return new ServiceStartError({
    providerId: input.service.provider,
    operation: input.operation,
    service: input.service.name,
    message,
    remediation,
    ...(input.details === undefined ? {} : { details: redactDetails(input.details, redactor) }),
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
          deps.redactor,
        ),
        details: redactDetails({ name, status: response.status, body: response.body }, deps.redactor),
        remediation: deps.remediation,
      }),
    );
  }
  const body = yield* parseEngineJson(response, deps.options.ctx, "bringUp.inspect", {
    details: redactDetails({ status: response.status, body: response.body }, deps.redactor),
    remediation: deps.remediation,
  });
  if (typeof body !== "object" || body === null || !("State" in body)) {
    return {
      exists: true,
      running: false,
      publishFingerprint: fingerprintInspectPublishPorts(body),
      bindSources: inspectBindSources(body),
      networkNames: inspectNetworkNames(body),
      labels: inspectContainerLabels(body),
      body,
    };
  }
  return {
    exists: true,
    running: containerRunning(body),
    publishFingerprint: fingerprintInspectPublishPorts(body),
    bindSources: inspectBindSources(body),
    networkNames: inspectNetworkNames(body),
    labels: inspectContainerLabels(body),
    body,
  };
});

const createContainerRequest = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  endpoints: ReadonlyArray<EndpointPlan>,
) => {
  const knobs = realizePodmanComposeKnobs(service, {
    dialect: (deps.options.dialect ?? libpodLifecycleDialect).engine,
    onInvalid: (message, details) => {
      throw podmanFailure(deps, { service, operation: "bringUp.knobs", message, details });
    },
  });
  const baseHostConfig = containerHostConfigFragment(plan, service, { endpoints });
  const attachments = createBodyAttachments(deps, plan, service);
  const gatewayPriority =
    (deps.options.dialect ?? libpodLifecycleDialect).sharedNetworkAttachment === "connect-after-create" &&
    attachments.length > 0;
  const body = {
    ...containerCreateBodyFragment(plan, service, {
      name,
      labels: commonContainerLabels(plan, service),
      hostConfig: {
        ...baseHostConfig,
        ...knobs.hostConfig,
      },
      networkingConfig: {
        EndpointsConfig: Object.fromEntries(
          attachments.map(({ name, aliases }) => [
            name,
            {
              Aliases: aliases,
              ...(gatewayPriority ? { GwPriority: 1 } : {}),
            },
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
      environment: deps.creationEnvironments.get(service.name) ?? literalServiceEnvironment(service),
    }),
    ...knobs.topLevel,
  };
  const searchParams = new URLSearchParams({ name, ...knobs.query });
  const path: EngineHttpRequest["path"] = `/containers/create?${searchParams.toString()}`;
  return {
    body,
    path,
    ...(gatewayPriority ? { minimumApiVersion: "1.48" as const } : {}),
  };
};

const ensureNetwork = (
  deps: BringUpDeps,
  name: string,
  plan: AppPlan,
): Effect.Effect<void, ProviderError> => {
  const driver =
    (plan.networking?.perAppBridge?.name === name ? plan.networking.perAppBridge.driver : undefined) ??
    "bridge";
  const preferredBridge =
    (deps.options.dialect ?? libpodLifecycleDialect).engine === "libpod" &&
    landoAppNetworkName(plan) === name &&
    !isSharedNetwork(plan, name);
  const createFailure = (response: EngineHttpResponse) => {
    const details = { status: response.status, body: response.body };
    const message = withApiReason(
      `provider-${deps.options.ctx.providerId} network create failed with HTTP ${response.status}.`,
      details,
      deps.redactor,
    );
    return new ProviderUnavailableError({
      providerId: deps.options.ctx.providerId,
      operation: "bringUp.network",
      message,
      details: redactDetails(details, deps.redactor),
      remediation:
        deps.options.startFailureRemediation?.({ operation: "bringUp.network", message, details }) ??
        deps.remediation,
    });
  };
  const create = (labels?: Readonly<Record<string, string>>) =>
    creationEligibility(plan).pipe(
      Effect.andThen(() =>
        request(deps, {
          method: "POST",
          path: preferredBridge ? "/libpod/networks/create" : "/networks/create",
          body: preferredBridge
            ? { name, driver, dns_enabled: true, options: { metric: "50" }, labels }
            : { Name: name, Driver: driver, ...(labels === undefined ? {} : { Labels: labels }) },
        }),
      ),
    );
  if (!isSharedNetwork(plan, name)) {
    return ensurePrivateNetwork(
      (input) => request(deps, input),
      {
        plan,
        name,
        driver,
        create,
        createFailure,
      },
      deps.options.ctx,
    );
  }
  return request(deps, { method: "GET", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((inspectResponse) => {
      if (inspectResponse.status === 200) return Effect.void;
      return create().pipe(
        Effect.flatMap((response) =>
          response.status === 200 || response.status === 201 || response.status === 409
            ? Effect.void
            : Effect.fail(createFailure(response)),
        ),
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
): Effect.Effect<readonly VolumeCreationFact[], ProviderError> =>
  Effect.gen(function* () {
    if (plan.valueModel !== 1) {
      const observed = yield* request(deps, {
        method: "GET",
        path: `/volumes/${encodeURIComponent(store.name)}`,
      });
      if (observed.status === 200) return [];
      yield* creationEligibility(plan);
    }
    const labels = podmanVolumeCreationLabels(plan, store);
    return yield* request(deps, {
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
              deps.redactor,
            ),
            details: redactDetails(
              { name: store.name, status: response.status, body: response.body },
              deps.redactor,
            ),
            remediation: deps.remediation,
          }),
        );
      }),
    );
  });

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
  yield* prepareCreationEnvironment(deps, plan, service);
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

/** Docker accepts one network in the create body; the rest are connected after create. */
const createBodyAttachments = (deps: BringUpDeps, plan: AppPlan, service: ServicePlan) =>
  (deps.options.dialect ?? libpodLifecycleDialect).sharedNetworkAttachment === "connect-after-create"
    ? landoServiceNetworkAttachments(plan, service).slice(0, 1)
    : landoServiceNetworkAttachments(plan, service);

/** Existing Docker containers need an idempotent connect even when create would attach the shared network. */
const attachmentsAfterCreate = (deps: BringUpDeps, plan: AppPlan, service: ServicePlan, created: boolean) =>
  (deps.options.dialect ?? libpodLifecycleDialect).sharedNetworkAttachment === "connect-after-create"
    ? landoServiceNetworkAttachments(plan, service).slice(
        created || plan.networking?.perAppBridge !== null ? 1 : 0,
      )
    : [];

const connectNetwork = (
  deps: BringUpDeps,
  service: ServicePlan,
  name: string,
  attachment: ServiceNetworkAttachment,
): Effect.Effect<void, BringUpError> =>
  request(deps, {
    method: "POST",
    path: `/networks/${encodeURIComponent(attachment.name)}/connect`,
    body: {
      Container: name,
      EndpointConfig: { Aliases: attachment.aliases },
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

const removeContainer = (deps: BringUpDeps, service: ServicePlan, name: string) =>
  removeRuntimeContainer(deps.api, name, { ...deps.options.ctx, operation: "bringUp.remove" }).pipe(
    Effect.mapError((cause) =>
      podmanFailure(deps, {
        service,
        operation: "bringUp.remove",
        message: cause.message,
        details: cause.details,
        cause,
      }),
    ),
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
              remediation: deps.remediation,
              cause,
            }),
        ),
      );

const startService = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
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
  const existingId = inspected.exists
    ? yield* verifiedNativeId(
        JSON.stringify(inspected.body),
        containerOwnershipLabels(plan, service.name),
        deps.options.ctx,
      )
    : undefined;
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
  const recreateReasons = inspected.exists ? bringUpRecreateReasons(plan, service, inspected) : [];
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
    yield* prepareCreationEnvironment(deps, plan, service);
    if (existingId !== undefined) {
      yield* stopContainerSilent(deps, existingId);
      yield* removeContainer(deps, service, existingId);
    }
    before = {
      exists: false,
      running: false,
      publishFingerprint: "",
      bindSources: undefined,
      networkNames: undefined,
    };
  }
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
  for (const attachment of attachmentsAfterCreate(deps, plan, service, !before.exists)) {
    yield* connectNetwork(deps, service, name, attachment);
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
        yield* prepareCreationEnvironment(deps, plan, service);
        const recoveryId = yield* inspectOwnedNativeId(
          deps.api,
          { kind: "container", name, labels: containerOwnershipLabels(plan, service.name) },
          deps.options.ctx,
        );
        if (recoveryId !== undefined) {
          yield* stopContainerSilent(deps, recoveryId);
          yield* removeContainer(deps, service, recoveryId);
        }
        createEndpoints = yield* prepareEndpoints(assigned);
        yield* createContainer(deps, plan, service, name, createEndpoints, prepareEndpoints);
        for (const attachment of attachmentsAfterCreate(deps, plan, service, true)) {
          yield* connectNetwork(deps, service, name, attachment);
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
  const state =
    after.body !== undefined && typeof after.body === "object" && after.body !== null
      ? Reflect.get(after.body, "State")
      : undefined;
  const engineStatus = typeof state === "object" && state !== null ? Reflect.get(state, "Status") : undefined;
  const terminal = engineStatus === "exited" || engineStatus === "dead";
  const completed =
    completionIntentServices(deps.options.completionPlan ?? plan).has(String(service.name)) &&
    after.exists &&
    typeof state === "object" &&
    state !== null &&
    Reflect.get(state, "ExitCode") === 0 &&
    terminal;
  const completionIntent = completionIntentServices(deps.options.completionPlan ?? plan).has(
    String(service.name),
  );
  const exitCode = typeof state === "object" && state !== null ? Reflect.get(state, "ExitCode") : undefined;
  const supervised =
    !completionIntent &&
    after.exists &&
    (terminal || engineStatus === "restarting") &&
    typeof exitCode === "number" &&
    isServiceRestartExpected(service, exitCode);
  if (!after.running && !completed && !supervised) {
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

const SERVICE_START_LOG_TAIL_LINES = 50;
const SERVICE_START_LOG_TAIL_MAX_CHARS = 4000;
const SERVICE_START_LOG_TAIL_TIMEOUT = Duration.seconds(4);

export const capRedactedLogLines = (
  lines: ReadonlyArray<string>,
): { readonly lines: string[]; readonly truncated: boolean } => {
  const kept: string[] = [];
  let used = 0;
  let truncated = lines.length > SERVICE_START_LOG_TAIL_LINES;
  for (let index = lines.length - 1; index >= 0 && kept.length < SERVICE_START_LOG_TAIL_LINES; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const separator = kept.length === 0 ? 0 : 1;
    const remaining = SERVICE_START_LOG_TAIL_MAX_CHARS - used - separator;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (line.length <= remaining) {
      kept.unshift(line);
      used += line.length + separator;
      continue;
    }
    kept.unshift(line.slice(line.length - remaining));
    truncated = true;
    break;
  }
  return { lines: kept, truncated };
};

const captureServiceLogTail = Effect.fnUntraced(
  function* (
    deps: BringUpDeps,
    plan: AppPlan,
    service: ServicePlan,
    extras?: { readonly exitCode?: number; readonly timedOut?: boolean },
  ): Effect.fn.Return<ServiceStartLogTail | undefined, ProviderError> {
    const collected = yield* Stream.runCollect(
      logs(
        plan,
        { app: plan.id, service: service.name },
        { follow: false, tail: SERVICE_START_LOG_TAIL_LINES, sources: [] },
        { api: deps.api, ctx: deps.options.ctx },
      ),
    );
    if (collected.length === 0) return undefined;
    const provided = yield* Effect.serviceOption(StartFailureLogRedactor);
    const redactor = Option.isSome(provided) ? provided.value : deps.redactor;
    const redacted = redactor.redactString(collected.map((chunk) => chunk.line).join("\n"));
    const { lines, truncated } = capRedactedLogLines(redacted.split("\n"));
    return {
      service: String(service.name),
      lines,
      truncated,
      ...(extras?.exitCode === undefined ? {} : { exitCode: extras.exitCode }),
      ...(extras?.timedOut === true ? { timedOut: true } : {}),
    };
  },
  Effect.timeout(SERVICE_START_LOG_TAIL_TIMEOUT),
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined),
  ),
);

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
        remediation: error.remediation,
        ...(error.cause === undefined ? {} : { cause: error.cause }),
        logTail,
      });

const captureStartFailure = (
  deps: BringUpDeps,
  plan: AppPlan,
  error: BringUpError,
): Effect.Effect<never, BringUpError> => {
  const aborted = deps.options.signal?.aborted === true;
  const named =
    !aborted && error instanceof ServiceStartError
      ? plan.services[ServiceName.make(error.service)]
      : undefined;
  const capture = named === undefined ? Effect.succeed(undefined) : captureServiceLogTail(deps, plan, named);
  return capture.pipe(
    Effect.flatMap((logTail) =>
      deps.options.signal?.aborted === true
        ? Effect.interrupt
        : Effect.fail(error instanceof ServiceStartError ? withServiceStartLogTail(error, logTail) : error),
    ),
  );
};

export const bringUp = Effect.fn("RuntimeProvider.bringUp")(function* (
  logicalPlan: AppPlan,
  options: BringUpOptions,
): Effect.fn.Return<ApplyResult, ProviderError> {
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
  const plan = yield* prepareFileModeMounts(logicalPlan, options.ctx, options.userDataRoot);
  const deps: BringUpDeps = {
    api,
    options,
    remediation: plan.id === "global" ? GLOBAL_APPLY_REMEDIATION : APPLY_REMEDIATION,
    creationEnvironments: new Map(),
    redactor: redactorFor(options.ctx),
  };

  const networkNames = new Set(
    Object.values(plan.services).flatMap((service) =>
      landoServiceNetworkAttachments(plan, service).map(({ name }) => name),
    ),
  );
  const externalNames = new Set(landoExternalNetworkNames(plan));
  for (const name of networkNames) {
    if (!externalNames.has(name)) continue;
    yield* preflightExternalNetwork(api, name, options.ctx);
  }

  for (const service of Object.values(plan.services)) {
    const inspected = yield* inspectContainer(deps, containerName(plan, service));
    const replacing =
      inspected.exists &&
      (options.reconcile === true || bringUpRecreateReasons(plan, service, inspected).length > 0);
    if ((!inspected.exists || replacing) && options.forbidRecreate !== true) {
      yield* prepareCreationEnvironment(deps, plan, service);
    }
  }

  for (const name of networkNames) {
    const authored = plan.networking?.authoredNetworks?.find((network) => network.name === name);
    if (authored?.external === true) continue;
    if (authored !== undefined) {
      yield* creationEligibility(plan);
      yield* ensureAuthoredNetwork(api, { plan, network: authored }, options.ctx);
    } else {
      yield* ensureNetwork(deps, name, plan);
    }
  }
  const createdVolumes: VolumeCreationFact[] = [];
  for (const store of plan.stores) {
    for (const fact of yield* ensureVolume(deps, plan, store)) {
      if (options.onVolumeCreated !== undefined) yield* options.onVolumeCreated(fact);
      createdVolumes.push(fact);
    }
  }
  const result = yield* runServiceStartSchedule(plan, {
    startService: Effect.fnUntraced(function* (service) {
      if (options.signal?.aborted === true) {
        return yield* Effect.interrupt;
      }
      return yield* startService(deps, plan, service).pipe(
        Effect.catch((error) => (options.signal?.aborted === true ? Effect.interrupt : Effect.fail(error))),
      );
    }),
    execHealthcheck: (service, command) =>
      exec(
        plan,
        { app: plan.id, service: service.name },
        { command, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        {
          api,
          ctx: options.ctx,
          resolveContainerHelper: options.resolveContainerHelper,
          helperTarget: options.helperTarget,
        },
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
  }).pipe(Effect.catch((error) => captureStartFailure(deps, plan, error)));

  if (result._tag === "Cycle") {
    return yield* Effect.fail(
      new ProviderInternalError({
        providerId: options.ctx.providerId,
        operation: "bringUp.schedule",
        message: `provider-${options.ctx.providerId} bringUp service schedule contains a dependency cycle.`,
        remediation: deps.remediation,
        details: redactDetails({ edges: result.edges }, deps.redactor),
      }),
    );
  }
  const [blocked] = result.blocked;
  if (blocked !== undefined) {
    const aborted = options.signal?.aborted === true;
    const service = plan.services[ServiceName.make(blocked.service)];
    const dependency = plan.services[ServiceName.make(blocked.dependency)];
    const capture =
      aborted || dependency === undefined
        ? Effect.succeed(undefined)
        : captureServiceLogTail(deps, plan, dependency, {
            ...(blocked.lastExitCode === undefined ? {} : { exitCode: blocked.lastExitCode }),
            ...(blocked.timedOut === true ? { timedOut: true } : {}),
          });
    return yield* capture.pipe(
      Effect.flatMap((logTail): Effect.Effect<never, BringUpError> => {
        if (options.signal?.aborted === true) return Effect.interrupt;
        if (service === undefined) {
          return Effect.fail(
            new ProviderInternalError({
              providerId: options.ctx.providerId,
              operation: "bringUp.schedule",
              message: `provider-${options.ctx.providerId} bringUp schedule blocked an unknown service.`,
              remediation: deps.remediation,
              details: redactDetails(blocked, deps.redactor),
            }),
          );
        }
        return Effect.fail(
          podmanFailure(deps, {
            service,
            operation: "bringUp.schedule",
            message: `Service ${blocked.service} could not start because dependency gate ${blocked.unmetGate} was not satisfied.`,
            ...(logTail === undefined ? {} : { logTail }),
          }),
        );
      }),
    );
  }

  return { changed: result.changed || createdVolumes.length > 0, createdVolumes };
});
