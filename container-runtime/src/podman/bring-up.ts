import { redactProviderError } from "@lando/redaction/provider-error";
import {
  FailureRoleAnnotation,
  annotateFailureRole,
  mapDefectCause,
  mapFailures,
  mergeFailure,
  withDeadline,
} from "@lando/sdk/command-result";
import {
  EnvironmentValueResolutionError,
  PlanReplanRequiredError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  ServiceStartError,
  type ServiceStartLogTail,
} from "@lando/sdk/errors";
import { PostServiceStartEvent, PreServiceStartEvent } from "@lando/sdk/events";
import type { ListenerObservation, VolumeCreationFact } from "@lando/sdk/schema";
import {
  type AppPlan,
  type AppRef,
  DEPENDENCY_ENVIRONMENT_EXTENSION_KEY,
  DependencyEnvironmentJob,
  type EndpointPlan,
  type HostPlatform,
  LANDO_DATA_ROOT_LABEL,
  ProviderId,
  type ServiceContainerChange,
  ServiceName,
  type ServiceNetworkAttachment,
  type ServicePlan,
  landoAppNetworkName,
  landoExternalNetworkNames,
  landoServiceNetworkAttachments,
} from "@lando/sdk/schema";
import type { ApplyOptions, ApplyResult, EventService, ProviderError } from "@lando/sdk/services";
import { Cause, Context, DateTime, Duration, Effect, Exit, Option, Schema, Stream } from "effect";
import { prepareContainerHelperMounts } from "../container-helper-mount.ts";
import { removeRuntimeContainer } from "../container-removal.ts";
import { sharedNetworkLabels } from "../data-root-labels.ts";
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
  interruptOnAbort,
  unsupportedHealthcheckTarget,
  validateHealthcheckExecution,
} from "../healthcheck-attempt.ts";
import { inspectImageUser } from "../image-build-user.ts";
import { isProducedArtifact, producedImageMissing } from "../image-ensure.ts";
import { PROVIDER_LABEL } from "../labels.ts";
import { listenerAuthorityAction, listenerDiagnostic } from "../listener-diagnostic.ts";
import { observeTcpListener } from "../listener-observation.ts";
import {
  containerOwnershipLabels,
  decodeNativeObservation,
  inspectOwnedNativeId,
  isSharedNetwork,
  matchesDataRoot,
  verifiedNativeId,
} from "../native-ownership.ts";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  fingerprintInspectPublishPorts,
  fingerprintPlannedPublishPorts,
  projectUserNumericCreateUser,
  serviceContainerName,
} from "../plan.ts";
import { StartFailureLogRedactor, redactDetails, redactorFor, withApiReason } from "../redact.ts";
import type { OwnedResource } from "../resource-ownership-inventory.ts";
import { compileServiceProbe } from "../service-probe.ts";
import {
  type ServicePublishProbe,
  classifyServicePublishHost,
  copyInspectHostPorts,
  createAssignedHostPorts,
  isHostPortBindRejection,
  prepareCreatePublishEndpoints,
  shouldProbeServicePublishPort,
} from "../service-publish-ports.ts";
import {
  type CompletionWaitResult,
  type DependencyExit,
  type DependencyUnavailableReason,
  type DependencyWatchResult,
  type HostProbeObservation,
  runServiceStartSchedule,
} from "../service-start-schedule.ts";
import { type ShutdownIdentity, observeShutdown } from "../shutdown-observation.ts";
import { restartVerdict } from "../supervision.ts";
import { volumeCreationFact, volumeCreationLabels } from "../volume-creation.ts";
import {
  coherentVolumeOwnership,
  historicalInventoryVolume,
  historicalVolume,
  isGlobalCacheStore,
  volumeOwnershipLabels,
} from "../volume-ownership.ts";
import { waitNativeContainer } from "../wait-for-exit.ts";
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
} from "./bring-up-recreate.ts";
import { realizePodmanComposeKnobs } from "./compose-knobs.ts";
import { type ExecOptions, exec, execStream } from "./exec.ts";
import { containerConsoleLogs } from "./logs.ts";
import {
  listLabeledServiceContainers,
  removeStaleServiceContainers,
  selectStaleServiceContainers,
} from "./stale-service-containers.ts";
import { startObservation } from "./start-observation.ts";

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

export const SCRATCH_APPLY_REMEDIATION =
  "Fix the reported error, then retry the scratch command. Run `lando doctor` if the failure persists.";

const isScratchPlan = (plan: AppPlan): boolean => plan.extensions["@lando/core/scratch"] !== undefined;

const applyRemediationFor = (plan: AppPlan): string =>
  plan.id === "global"
    ? GLOBAL_APPLY_REMEDIATION
    : isScratchPlan(plan)
      ? SCRATCH_APPLY_REMEDIATION
      : APPLY_REMEDIATION;

export const dependencyGateRemediation = (plan: AppPlan, dependency: string): string => {
  const job = plan.services[ServiceName.make(dependency)]?.extensions[DEPENDENCY_ENVIRONMENT_EXTENSION_KEY];
  if (Schema.is(DependencyEnvironmentJob)(job) && job.inputs !== undefined)
    return `Run \`lando logs -s ${dependency}\`, fix ${job.inputs}, then run \`lando start\` again.`;
  if (plan.id === "global")
    return `Run \`lando global:logs -s ${dependency}\` to diagnose dependency ${dependency}, fix it, then run \`lando global:start\`.`;
  if (isScratchPlan(plan))
    return `Run \`lando scratch logs ${plan.id}\` to diagnose dependency ${dependency}, fix it, then retry the scratch command.`;
  return `Run \`lando logs -s ${dependency}\` to diagnose dependency ${dependency}, fix it, then run \`lando start\`; it reuses what this attempt created.`;
};

interface InspectResult {
  readonly exists: boolean;
  readonly running: boolean;
  readonly publishFingerprint: string;
  readonly bindSources: Readonly<Record<string, string>> | undefined;
  readonly networkNames: ReadonlyArray<string> | undefined;
  readonly labels?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * `startedIdentity` is the ownership-verified native id this start owns (create 201
 * body, 409 ownership read, or the already-verified reuse id). Gated services start
 * by that id and post-start-inspect by planned name must still resolve to it.
 */
interface StartResult {
  readonly changed: boolean;
  readonly startedIdentity?: string;
  readonly dependencyUnavailable?: { readonly reason: DependencyUnavailableReason };
  readonly startFailure?: {
    readonly status: "exited" | "dead" | "not-running";
    readonly exitCode?: number;
  };
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
  readonly previousPlan?: AppPlan | undefined;
  /** Inventory-only ownership rows when no previous applied plan remains. */
  readonly ownershipInventory?: ReadonlyArray<OwnedResource> | undefined;
  readonly executeReadinessAttempt?: ApplyOptions["executeReadinessAttempt"];
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
  readonly completionPlan?: AppPlan;
  readonly userDataRoot?: string | undefined;
}

interface BringUpDeps {
  readonly api: EngineHttpApi;
  readonly options: BringUpOptions;
  readonly remediation: string;
  readonly creationEnvironments: Map<string, Readonly<Record<string, string>>>;
  readonly changes: Map<string, ServiceContainerChange>;
  readonly networkIds: Map<string, string>;
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
  readonly listener?: ListenerObservation;
  readonly remediation?: string;
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
    }) ??
    input.remediation ??
    deps.remediation;
  return new ServiceStartError({
    providerId: input.service.provider,
    operation: input.operation,
    service: input.service.name,
    message,
    remediation,
    ...(input.details === undefined ? {} : { details: redactDetails(input.details, redactor) }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    ...(input.logTail === undefined ? {} : { logTail: input.logTail }),
    ...(input.listener === undefined ? {} : { listener: input.listener }),
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
  createUser?: string,
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
      ...(createUser === undefined ? {} : { createUser }),
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
): Effect.Effect<string | undefined, ProviderError> => {
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
  const sharedDataRoot = isSharedNetwork(plan, name) ? plan.identity?.dataRoot : undefined;
  if (!isSharedNetwork(plan, name) || sharedDataRoot !== undefined) {
    return ensurePrivateNetwork(
      (input) => request(deps, input),
      {
        plan,
        name,
        driver,
        create,
        createFailure,
        previousPlan: deps.options.previousPlan,
        ...(sharedDataRoot === undefined
          ? {}
          : { sharedDataRoot, labels: sharedNetworkLabels(sharedDataRoot) }),
      },
      deps.options.ctx,
    );
  }
  return request(deps, { method: "GET", path: `/networks/${encodeURIComponent(name)}` })
    .pipe(
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
    )
    .pipe(Effect.as(undefined));
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
      Effect.flatMap(
        Effect.fnUntraced(function* (response) {
          if (
            (response.status === 200 || response.status === 201 || response.status === 409) &&
            plan.identity?.dataRoot !== undefined &&
            !isGlobalCacheStore(store)
          ) {
            const fact = volumeCreationFact({ body: response.body, name: store.name, labels });
            if (response.status !== 409 && fact.length > 0) return fact;
            const inspected = yield* request(deps, {
              method: "GET",
              path: `/volumes/${encodeURIComponent(store.name)}`,
            });
            const observed = inspected.status === 200 ? decodeNativeObservation(inspected.body) : undefined;
            const actual = observed?.Labels ?? observed?.labels ?? {};
            const owner = actual[LANDO_DATA_ROOT_LABEL];
            if (
              observed?.Name === store.name &&
              coherentVolumeOwnership(actual, plan.provider) &&
              Object.entries(volumeOwnershipLabels(plan, store)).every(([key, value]) =>
                key === LANDO_DATA_ROOT_LABEL
                  ? matchesDataRoot(
                      owner,
                      value,
                      historicalVolume(deps.options.previousPlan, plan, store.name) ||
                        historicalInventoryVolume(deps.options.ownershipInventory, plan, store.name),
                    )
                  : actual[key] === value,
              )
            )
              return [];
            return yield* new ProviderUnavailableError({
              providerId: plan.provider,
              operation: "bringUp.volume",
              message: `Cannot verify ownership of volume ${store.name}.`,
              remediation:
                owner !== undefined && owner !== plan.identity.dataRoot
                  ? `Use the Lando installation with data root ${owner} to manage this volume.`
                  : "Export the volume data before recreating the store, then restore the data.",
            });
          }
          if (response.status === 201 || response.status === 200)
            return volumeCreationFact({ body: response.body, name: store.name, labels });
          if (response.status === 409) return [];
          return yield* Effect.fail(
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
      ),
    );
  });

export const isMissingImageCreateResponse = (response: EngineHttpResponse): boolean =>
  response.status === 404 || /no such image/iu.test(response.body);

/**
 * The identity the container is created as. A project-user create always
 * names it explicitly: without one, keep-id runs the container as the mapped
 * id instead of the image's configured user. An image-renumber catalog plan
 * keeps the image user so a root master stays root; a numeric image-renumber
 * plan is a custom image and runs as the host ids that replaced its authored
 * numeric user. Otherwise an authored `user:` wins, and without one the image's
 * own user is read without running anything.
 */
const resolvedCreateUser = (
  deps: BringUpDeps,
  service: ServicePlan,
): Effect.Effect<string | undefined, ProviderError> => {
  if (service.projectUser === undefined) return Effect.succeed(undefined);
  // A renumbered custom image replaces its authored numeric user with the host ids.
  const numeric = projectUserNumericCreateUser(service);
  if (numeric !== undefined) return Effect.succeed(numeric);
  if (service.user !== undefined && service.user.length > 0) return Effect.succeed(service.user);
  const artifact = service.artifact;
  const request = deps.api.request;
  if (artifact?.kind !== "ref" || request === undefined) return Effect.succeed("root");
  return inspectImageUser({
    baseRef: artifact.ref,
    providerId: deps.options.ctx.providerId,
    request,
    operation: "bringUp.create",
    subject: "service image",
  });
};

const buildCreateRequest = Effect.fn("RuntimeProvider.buildCreateRequest")(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  endpoints: ReadonlyArray<EndpointPlan>,
) {
  const createUser = yield* resolvedCreateUser(deps, service);
  return yield* Effect.try({
    try: () => createContainerRequest(deps, plan, service, name, endpoints, createUser),
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
});

/** True when another service waits on a non-started gate of `service` (healthy/completed). */
const serviceNeedsStartIdentity = (plan: AppPlan, service: ServicePlan): boolean =>
  Object.values(plan.services).some((dependent) =>
    dependent.dependsOn.some((edge) => edge.condition !== "service_started" && edge.service === service.name),
  );

/** Native id from a successful create body (201/200). Create responses carry Id only, not labels. */
const parseCreateResponseId = (body: string): string | undefined => {
  if (body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    for (const key of ["Id", "ID", "id"] as const) {
      const value = Reflect.get(parsed, key);
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Proof of the container create produced or adopted. 201 keeps the response Id;
 * 409 requires an ownership read of the planned name before adoption.
 */
const identityFromCreateResponse = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  response: EngineHttpResponse,
): Effect.Effect<string | undefined, BringUpError> => {
  if (response.status === 201 || response.status === 200) {
    return Effect.succeed(parseCreateResponseId(response.body));
  }
  if (response.status !== 409) return Effect.succeed(undefined);
  return inspectOwnedNativeId(
    deps.api,
    { kind: "container", name, labels: containerOwnershipLabels(plan, service.name) },
    deps.options.ctx,
  ).pipe(
    Effect.flatMap((id) =>
      id === undefined
        ? Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.create",
              message: `provider-${deps.options.ctx.providerId} container create conflicted but no owned container named ${name} was found.`,
              details: { status: response.status, body: response.body },
            }),
          )
        : Effect.succeed(id),
    ),
    mapFailures((cause) =>
      cause instanceof ServiceStartError
        ? cause
        : podmanFailure(deps, {
            service,
            operation: "bringUp.create",
            message: `provider-${deps.options.ctx.providerId} could not verify ownership after a container create conflict for ${name}.`,
            details: { status: response.status, body: response.body },
            cause,
          }),
    ),
  );
};

interface CreateContainerResult {
  readonly endpoints: ReadonlyArray<EndpointPlan>;
  readonly identity?: string;
}

const createContainer = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  endpoints: ReadonlyArray<EndpointPlan>,
  reassign: (exclude: ReadonlySet<number>) => Effect.Effect<ReadonlyArray<EndpointPlan>, BringUpError>,
): Effect.fn.Return<CreateContainerResult, BringUpError> {
  yield* prepareCreationEnvironment(deps, plan, service);
  if (service.artifact?.kind === "ref" && deps.options.ensureImage !== undefined) {
    yield* deps.options.ensureImage({ service, ref: service.artifact.ref, force: false });
  }
  let createRequest = yield* buildCreateRequest(deps, plan, service, name, endpoints);
  const response = yield* request(deps, { method: "POST", ...createRequest });
  if (response.status === 201 || response.status === 200 || response.status === 409) {
    const identity = yield* identityFromCreateResponse(deps, plan, service, name, response);
    return { endpoints, ...(identity === undefined ? {} : { identity }) };
  }
  if (
    deps.options.retryCreateOnMissingImage === true &&
    deps.options.ensureImage !== undefined &&
    service.artifact?.kind === "ref" &&
    isMissingImageCreateResponse(response)
  ) {
    // A Lando-built image exists in no registry; the forced pull that repairs Docker's
    // inspect-200/create-404 disagreement would only reach for a tag that was never published.
    if (isProducedArtifact(service)) {
      return yield* Effect.fail(
        producedImageMissing(deps.options.ctx, String(service.name), service.artifact.ref),
      );
    }
    yield* deps.options.ensureImage({ service, ref: service.artifact.ref, force: true });
    const retry = yield* request(deps, { method: "POST", ...createRequest });
    if (retry.status === 201 || retry.status === 200 || retry.status === 409) {
      const identity = yield* identityFromCreateResponse(deps, plan, service, name, retry);
      return { endpoints, ...(identity === undefined ? {} : { identity }) };
    }
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
  const rebound = yield* reassign(createAssignedHostPorts(endpoints));
  createRequest = yield* buildCreateRequest(deps, plan, service, name, rebound);
  const bindRetry = yield* request(deps, { method: "POST", ...createRequest });
  if (bindRetry.status === 201 || bindRetry.status === 200 || bindRetry.status === 409) {
    const identity = yield* identityFromCreateResponse(deps, plan, service, name, bindRetry);
    return { endpoints: rebound, ...(identity === undefined ? {} : { identity }) };
  }
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
    path: `/networks/${encodeURIComponent(deps.networkIds.get(attachment.name) ?? attachment.name)}/connect`,
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

const stopCompletionJob = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  identity: ShutdownIdentity & { readonly containerId: string },
) {
  const failure = (message: string, details?: unknown) =>
    new ProviderUnavailableError({
      providerId: identity.providerId,
      operation: "bringUp.completion.stop",
      message: `Could not confirm ${identity.service} stopped after interruption: ${message}`,
      remediation: `Check the runtime and stop service ${identity.service} before retrying.`,
      ...(details === undefined ? {} : { details: redactDetails(details, deps.redactor) }),
    });
  const stopped = yield* withDeadline(
    Effect.interruptible(
      request(deps, {
        method: "POST",
        path: `/containers/${encodeURIComponent(identity.containerId)}/stop`,
      }),
    ),
    Duration.seconds(30),
  ).pipe(mapFailures((cause) => failure(deps.redactor.redactString(cause.message))));
  if (stopped._tag === "TimedOut") return yield* failure("the stop request timed out.");
  const { status } = stopped.value;
  if (status !== 204 && status !== 304 && status !== 404)
    return yield* failure(`the stop request returned HTTP ${status}.`);
  const observed = yield* Effect.interruptible(
    observeShutdown(identity, { api: deps.api, ctx: deps.options.ctx }),
  );
  if (observed.status === "exited" || observed.reason === "container-absent") return;
  return yield* failure(`shutdown inspection reported ${observed.reason}.`, {
    shutdownObservations: [observed],
  });
});

const removeContainer = (deps: BringUpDeps, service: ServicePlan, name: string) =>
  removeRuntimeContainer(deps.api, name, { ...deps.options.ctx, operation: "bringUp.remove" }).pipe(
    mapFailures((cause) =>
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
        mapFailures(
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

/**
 * Anonymous volumes are the inspected container's volume mounts that no planned mount or store of
 * the service covers. They leave with a replaced container, so the change reports their paths.
 */
const anonymousVolumePaths = (service: ServicePlan, body: unknown): ReadonlyArray<string> => {
  if (typeof body !== "object" || body === null) return [];
  const mounts = Reflect.get(body, "Mounts");
  if (!Array.isArray(mounts)) return [];
  const planned = new Set<string>(service.mounts.map((mount) => mount.target));
  const paths: string[] = [];
  for (const mount of mounts) {
    if (typeof mount !== "object" || mount === null) continue;
    if (Reflect.get(mount, "Type") !== "volume") continue;
    const destination = Reflect.get(mount, "Destination");
    if (typeof destination !== "string" || planned.has(destination)) continue;
    paths.push(destination);
  }
  return paths;
};

const startService = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  inspectedBeforeSchedule?: InspectResult,
): Effect.fn.Return<StartResult, BringUpError> {
  const name = containerName(plan, service);
  const providerId = ProviderId.make(deps.options.ctx.providerId);
  const needsIdentity = serviceNeedsStartIdentity(plan, service);

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

  const inspected = inspectedBeforeSchedule ?? (yield* inspectContainer(deps, name));
  const previous = deps.options.previousPlan;
  const legacy =
    inspected.labels?.[LANDO_DATA_ROOT_LABEL] === undefined &&
    previous !== undefined &&
    previous.root === plan.root &&
    previous.provider === plan.provider &&
    previous.id === plan.id &&
    matchesDataRoot(previous.identity?.dataRoot, plan.identity?.dataRoot, true) &&
    Object.hasOwn(previous.services, service.name) &&
    serviceContainerName(previous, service.name) === name;
  const expected: Readonly<Record<string, string>> = containerOwnershipLabels(plan, service.name);
  const { [LANDO_DATA_ROOT_LABEL]: _dataRoot, ...historicalLabels } = expected;
  const existingId = inspected.exists
    ? yield* verifiedNativeId(
        JSON.stringify(inspected.body),
        legacy ? historicalLabels : expected,
        deps.options.ctx,
      )
    : undefined;
  const published = service.endpoints.flatMap((endpoint) =>
    endpoint.kind === "published" ? [endpoint] : [],
  );
  const plannedFingerprint = fingerprintPlannedPublishPorts(published);
  const portMismatch =
    plannedFingerprint.length > 0 &&
    inspected.publishFingerprint.length > 0 &&
    inspected.publishFingerprint !== plannedFingerprint;
  const existedBefore = inspected.exists;
  const recreateReasons = existedBefore ? bringUpRecreateReasons(plan, service, inspected) : [];
  let replacedReason: ServiceContainerChange["reason"];
  let before = inspected;
  let startedIdentity: string | undefined = before.exists ? existingId : undefined;
  if (before.exists && (legacy || deps.options.reconcile === true || recreateReasons.length > 0)) {
    yield* prepareCreationEnvironment(deps, plan, service);
    if (existingId !== undefined) {
      yield* stopContainerSilent(deps, existingId);
      yield* removeContainer(deps, service, existingId);
      replacedReason = deps.options.reconcile === true ? "reconcile" : recreateReasons[0];
    }
    before = {
      exists: false,
      running: false,
      publishFingerprint: "",
      bindSources: undefined,
      networkNames: undefined,
    };
    startedIdentity = undefined;
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
    const created = yield* createContainer(deps, plan, service, name, createEndpoints, prepareEndpoints);
    createEndpoints = created.endpoints;
    startedIdentity = created.identity;
    changed = true;
  }
  if (needsIdentity && startedIdentity === undefined) {
    return yield* Effect.fail(
      podmanFailure(deps, {
        service,
        operation: "bringUp.create",
        message: `provider-${deps.options.ctx.providerId} could not establish a start identity for ${name}.`,
      }),
    );
  }
  for (const attachment of attachmentsAfterCreate(deps, plan, service, !before.exists)) {
    yield* connectNetwork(deps, service, name, attachment);
  }
  const startRef = needsIdentity && startedIdentity !== undefined ? startedIdentity : name;
  if (!before.running) {
    const response = yield* startContainer(deps, startRef);
    if (response.status !== 204 && response.status !== 304) {
      const assigned = createAssignedHostPorts(
        createEndpoints.filter((_endpoint, index) => {
          const desired = service.endpoints[index];
          return desired?.kind === "published" && desired.publication.hostPort === undefined;
        }),
      );
      let retry: EngineHttpResponse | undefined;
      if (isHostPortBindRejection(response) && assigned.size > 0) {
        yield* prepareCreationEnvironment(deps, plan, service);
        const recoveryId =
          startedIdentity ??
          (yield* inspectOwnedNativeId(
            deps.api,
            { kind: "container", name, labels: containerOwnershipLabels(plan, service.name) },
            deps.options.ctx,
          ));
        if (recoveryId !== undefined) {
          yield* stopContainerSilent(deps, recoveryId);
          yield* removeContainer(deps, service, recoveryId);
          // Preserve the original replacement reason if bind recovery recreates it again.
          if (existedBefore) replacedReason ??= "host-port";
        }
        createEndpoints = yield* prepareEndpoints(assigned);
        const recovered = yield* createContainer(
          deps,
          plan,
          service,
          name,
          createEndpoints,
          prepareEndpoints,
        );
        createEndpoints = recovered.endpoints;
        // Bind recovery swaps the proof to the replacement container.
        startedIdentity = recovered.identity;
        if (needsIdentity && startedIdentity === undefined) {
          return yield* Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.create",
              message: `provider-${deps.options.ctx.providerId} bind recovery could not establish a start identity for ${name}.`,
            }),
          );
        }
        for (const attachment of attachmentsAfterCreate(deps, plan, service, true)) {
          yield* connectNetwork(deps, service, name, attachment);
        }
        const recoveryRef = needsIdentity && startedIdentity !== undefined ? startedIdentity : name;
        retry = yield* startContainer(deps, recoveryRef);
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

  // Post-start inspect is always by planned name; gated proof must still match.
  const after = yield* inspectContainer(deps, name);
  if (needsIdentity) {
    const afterId = after.exists ? yield* verifiedStartId(deps, plan, service, after.body) : undefined;
    if (afterId === undefined || afterId !== startedIdentity) {
      return {
        changed,
        dependencyUnavailable: {
          reason: !after.exists ? "missing" : afterId === undefined ? "unverified" : "replaced",
        },
      };
    }
  }
  const observed = startObservation(after.body);
  const completionIntent = completionIntentServices(deps.options.completionPlan ?? plan).has(
    String(service.name),
  );
  const completed = completionIntent && observed.status === "exited" && observed.exitCode === 0;
  const supervised =
    !completionIntent &&
    (observed.status === "restarting" || observed.status === "exited" || observed.status === "dead") &&
    restartVerdict({
      source: "planned",
      service,
      state: observed.status,
      exitCode: "exitCode" in observed ? observed.exitCode : undefined,
    }) === "expected";
  if ((!after.running || observed.status === "restarting") && !completed && !supervised) {
    // Gated services return evidence so a scheduled completion gate can project the
    // same diagnostic without a redundant wait. Direct starts keep the Effect failure.
    if (needsIdentity) {
      const action =
        replacedReason !== undefined
          ? "replaced"
          : !existedBefore
            ? "created"
            : before.running
              ? "kept"
              : "started";
      const anonymousVolumes = action === "replaced" ? anonymousVolumePaths(service, inspected.body) : [];
      deps.changes.set(String(service.name), {
        action,
        ...(replacedReason === undefined ? {} : { reason: replacedReason }),
        ...(anonymousVolumes.length === 0 ? {} : { anonymousVolumes }),
      });
      return {
        changed,
        ...(startedIdentity === undefined ? {} : { startedIdentity }),
        startFailure: {
          status:
            observed.status === "exited" || observed.status === "dead" ? observed.status : "not-running",
          ...("exitCode" in observed && observed.exitCode !== undefined
            ? { exitCode: observed.exitCode }
            : {}),
        },
      };
    }
    return yield* Effect.fail(
      podmanFailure(deps, {
        service,
        operation: "bringUp.start",
        message: `provider-${deps.options.ctx.providerId} container did not reach running state.`,
      }),
    );
  }

  const action =
    replacedReason !== undefined
      ? "replaced"
      : !existedBefore
        ? "created"
        : before.running
          ? "kept"
          : "started";
  const anonymousVolumes = action === "replaced" ? anonymousVolumePaths(service, inspected.body) : [];
  deps.changes.set(String(service.name), {
    action,
    ...(replacedReason === undefined ? {} : { reason: replacedReason }),
    ...(anonymousVolumes.length === 0 ? {} : { anonymousVolumes }),
  });

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

  return {
    changed,
    ...(needsIdentity && startedIdentity !== undefined ? { startedIdentity } : {}),
  };
});

const verifiedStartId = (deps: BringUpDeps, plan: AppPlan, service: ServicePlan, body: unknown) =>
  verifiedNativeId(JSON.stringify(body), containerOwnershipLabels(plan, service.name), deps.options.ctx).pipe(
    Effect.catchTag("ProviderUnavailableError", () => Effect.succeed(undefined)),
  );

const dependencyExitDetails = (service: string, gate: string, exit: DependencyExit) => ({
  dependencyExit:
    exit.status === "dead"
      ? { service, gate, status: exit.status }
      : {
          service,
          gate,
          status: exit.status,
          ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
        },
});

const inspectStartedContainer = Effect.fnUntraced(function* (
  deps: BringUpDeps,
  target: { readonly plan: AppPlan; readonly service: ServicePlan; readonly nativeId: string },
) {
  const { plan, service, nativeId } = target;
  const inspected = yield* inspectContainer(deps, containerName(plan, service));
  if (!inspected.exists) return { _tag: "Unavailable" as const, reason: "missing" as const };
  const observedId = yield* verifiedStartId(deps, plan, service, inspected.body);
  if (observedId === undefined) return { _tag: "Unavailable" as const, reason: "unverified" as const };
  if (observedId !== nativeId) return { _tag: "Unavailable" as const, reason: "replaced" as const };
  return { _tag: "Observed" as const, state: startObservation(inspected.body) };
});

const sanitizeDependencyInspect = <A, E extends ProviderError>(
  deps: BringUpDeps,
  inspect: Effect.Effect<A, E>,
) =>
  interruptOnAbort(
    inspect.pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(mapDefectCause(cause, () => "Dependency inspect defect.")),
      ),
      mapFailures((error) => redactProviderError(error, deps.redactor, { cause: "omit" })),
    ),
    deps.options.signal,
  );

/** A sample taken while the gate still retries: a slow inspect is inconclusive, never fatal. */
const inspectDependency = (
  deps: BringUpDeps,
  target: { readonly plan: AppPlan; readonly service: ServicePlan; readonly nativeId: string },
) =>
  sanitizeDependencyInspect(
    deps,
    withDeadline(inspectStartedContainer(deps, target), Duration.seconds(1)).pipe(
      Effect.map((checked) => (checked._tag === "Completed" ? checked.value : { _tag: "TimedOut" as const })),
    ),
  );

const terminalDependency = (
  state: ReturnType<typeof startObservation>,
  containerId: string,
): DependencyExit | undefined => {
  if (state.status !== "exited" && state.status !== "dead") return undefined;
  if (
    restartVerdict({
      source: "observed",
      state: state.status,
      policy: state.policy,
      exitCode: state.exitCode,
    }) !== "not-expected"
  )
    return undefined;
  return state.status === "dead"
    ? { status: "dead", containerId }
    : {
        status: "exited",
        containerId,
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
      };
};

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
    extras?: { readonly containerId?: string; readonly exitCode?: number; readonly timedOut?: boolean },
  ): Effect.fn.Return<ServiceStartLogTail | undefined, ProviderError> {
    const collected = yield* Stream.runCollect(
      containerConsoleLogs(
        deps.api,
        deps.options.ctx,
        extras?.containerId ?? containerName(plan, service),
        service.name,
        { follow: false, tail: SERVICE_START_LOG_TAIL_LINES, sources: [] },
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
  (effect) =>
    withDeadline(effect, SERVICE_START_LOG_TAIL_TIMEOUT).pipe(
      Effect.map((result) => (result._tag === "Completed" ? result.value : undefined)),
    ),
  Effect.catchCause((cause) =>
    cause.reasons.length === 1 &&
    cause.reasons[0]?._tag === "Fail" &&
    Context.getOrUndefined(Cause.reasonAnnotations(cause.reasons[0]), FailureRoleAnnotation) === undefined
      ? Effect.succeed(undefined)
      : Effect.failCause(mapDefectCause(cause, () => "Start log capture defect.")),
  ),
  (effect, deps) =>
    effect.pipe(mapFailures((error) => redactProviderError(error, deps.redactor, { cause: "omit" }))),
);

export const withServiceStartLogTail = (
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
        ...(error.listener === undefined ? {} : { listener: error.listener }),
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
    Effect.catchCause((cause) => Effect.failCause(mergeFailure(Cause.fail(error), cause, "cleanup"))),
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
  yield* validateHealthcheckExecution(logicalPlan, options.executeReadinessAttempt);
  const api = options.api;
  if (api?.request === undefined) {
    return yield* Effect.fail(missingApi(options.ctx, "bringUp"));
  }
  const prepared = yield* prepareFileModeMounts(logicalPlan, options.ctx, options.userDataRoot);
  const plan = yield* prepareContainerHelperMounts(prepared, options);
  const deps: BringUpDeps = {
    api,
    options,
    remediation: applyRemediationFor(plan),
    creationEnvironments: new Map(),
    changes: new Map(),
    networkIds: new Map(),
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
    yield* preflightExternalNetwork(api, name, options.ctx, plan.identity?.dataRoot);
  }

  const containers = yield* listLabeledServiceContainers(api, options.ctx, plan.id);
  const stales = selectStaleServiceContainers(plan, options.ctx.providerId, containers, options.previousPlan);
  const staleNameChanged = (yield* removeStaleServiceContainers(api, options.ctx, plan, stales)).changed;

  for (const service of Object.values(plan.services)) {
    const inspected = yield* inspectContainer(deps, containerName(plan, service));
    const replacing =
      inspected.exists &&
      (options.reconcile === true || bringUpRecreateReasons(plan, service, inspected).length > 0);
    if (!inspected.exists || replacing) {
      yield* prepareCreationEnvironment(deps, plan, service);
    }
  }

  for (const name of networkNames) {
    const authored = plan.networking?.authoredNetworks?.find((network) => network.name === name);
    if (authored?.external === true) continue;
    if (authored !== undefined) {
      yield* creationEligibility(plan);
      yield* ensureAuthoredNetwork(
        api,
        { plan, network: authored, previousPlan: options.previousPlan },
        options.ctx,
      );
    } else {
      const id = yield* ensureNetwork(deps, name, plan);
      if (id !== undefined && isSharedNetwork(plan, name)) deps.networkIds.set(name, id);
    }
  }
  const createdVolumes: VolumeCreationFact[] = [];
  for (const store of plan.stores) {
    for (const fact of yield* ensureVolume(deps, plan, store)) {
      if (options.onVolumeCreated !== undefined) yield* options.onVolumeCreated(fact);
      createdVolumes.push(fact);
    }
  }
  const startedIds = new Map<ServiceName, string>();
  const inspectedConsumers = new Map<ServiceName, InspectResult>();
  const idleJobs = new Set<ServiceName>();
  for (const service of Object.values(plan.services)) {
    const job = service.extensions[DEPENDENCY_ENVIRONMENT_EXTENSION_KEY];
    if (!Schema.is(DependencyEnvironmentJob)(job)) continue;
    let needed = false;
    for (const name of job.consumers) {
      const consumer = plan.services[ServiceName.make(name)];
      if (consumer === undefined) continue;
      if (options.reconcile === true) {
        needed = true;
        break;
      }
      const inspected =
        inspectedConsumers.get(consumer.name) ??
        (yield* inspectContainer(deps, containerName(plan, consumer)));
      inspectedConsumers.set(consumer.name, inspected);
      if (!inspected.running || bringUpRecreateReasons(plan, consumer, inspected).length > 0) {
        needed = true;
        break;
      }
    }
    if (!needed) idleJobs.add(service.name);
  }
  const scheduledPlan =
    idleJobs.size === 0
      ? plan
      : {
          ...plan,
          services: Object.fromEntries(
            Object.values(plan.services)
              .filter((service) => !idleJobs.has(service.name))
              .map((service) => [
                service.name,
                { ...service, dependsOn: service.dependsOn.filter((edge) => !idleJobs.has(edge.service)) },
              ]),
          ),
        };
  const result = yield* runServiceStartSchedule(scheduledPlan, {
    redactor: deps.redactor,
    redactProbeError: (error) =>
      deps.redactor.redactString(
        typeof error === "string"
          ? error
          : typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof error.message === "string"
            ? error.message
            : "Readiness attempt infrastructure failure.",
      ),
    startService: Effect.fnUntraced(function* (service) {
      if (options.signal?.aborted === true) {
        return yield* Effect.interrupt;
      }
      const started = yield* startService(
        deps,
        plan,
        plan.services[service.name] ?? service,
        inspectedConsumers.get(service.name),
      ).pipe(
        Effect.catch((error) => (options.signal?.aborted === true ? Effect.interrupt : Effect.fail(error))),
      );
      if (started.startedIdentity !== undefined) startedIds.set(service.name, started.startedIdentity);
      if (started.dependencyUnavailable !== undefined)
        return { changed: started.changed, dependencyUnavailable: started.dependencyUnavailable };
      const failure = started.startFailure;
      if (failure === undefined) return { changed: started.changed };
      const containerId = started.startedIdentity;
      if (containerId === undefined || failure.status === "not-running")
        return { changed: started.changed, dependencyUnavailable: { reason: "unverified" as const } };
      const terminalExit: DependencyExit =
        failure.status === "dead"
          ? { status: "dead", containerId }
          : {
              status: "exited",
              containerId,
              ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
            };
      return { changed: started.changed, terminalExit };
    }),
    checkHostProbeGreen: Effect.fnUntraced(function* (service): Effect.fn.Return<
      HostProbeObservation,
      ProviderError
    > {
      const nativeId = startedIds.get(service.name);
      if (nativeId === undefined) return { _tag: "Retry", dependencyUnavailable: { reason: "missing" } };
      const observed = yield* inspectDependency(deps, { plan, service, nativeId });
      if (observed._tag === "Unavailable")
        return { _tag: "Retry", dependencyUnavailable: { reason: observed.reason } };
      if (observed._tag === "TimedOut") return { _tag: "Retry", timedOut: true };
      if (observed.state.status === "running") return { _tag: "Running" };
      const exit = terminalDependency(observed.state, nativeId);
      return exit === undefined ? { _tag: "Retry" } : { _tag: "Terminal", exit };
    }),
    watchDependencyExit: Effect.fnUntraced(function* (service): Effect.fn.Return<
      DependencyWatchResult,
      ProviderError
    > {
      const nativeId = startedIds.get(service.name);
      if (nativeId === undefined) return { _tag: "Disarmed", reason: "unverified" };
      const waited = yield* waitNativeContainer(nativeId, {
        api,
        ctx: options.ctx,
        dialect: (options.dialect ?? libpodLifecycleDialect).wait,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (waited._tag === "Missing") return { _tag: "Disarmed", reason: "missing" };
      const observed = yield* inspectDependency(deps, { plan, service, nativeId });
      if (observed._tag !== "Observed")
        return { _tag: "Disarmed", reason: observed._tag === "Unavailable" ? observed.reason : "unverified" };
      const exit = terminalDependency(observed.state, nativeId);
      return exit === undefined ? { _tag: "Disarmed" } : { _tag: "Terminal", exit };
    }),
    execHealthcheck: (service, probe) =>
      interruptOnAbort(
        options.executeReadinessAttempt !== undefined
          ? options.executeReadinessAttempt(service.name, probe)
          : Effect.try({
              try: () => compileServiceProbe(probe, plan, service),
              catch: () =>
                new ServiceExecError({
                  providerId: options.ctx.providerId,
                  service: String(service.name),
                  operation: "readiness",
                  message: "The service readiness command could not be compiled.",
                  remediation: "Supply a command and a declared listener in the application plan.",
                }),
            }).pipe(
              Effect.flatMap((command) =>
                command === undefined
                  ? Effect.fail(unsupportedHealthcheckTarget(service.name, probe))
                  : exec(
                      plan,
                      {
                        app: plan.id,
                        service: service.name,
                        plan,
                        ...(probe.user === undefined ? {} : { user: probe.user }),
                      },
                      {
                        command: [...command],
                        raw: true,
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                      },
                      {
                        api,
                        ctx: options.ctx,
                        resolveContainerHelper: options.resolveContainerHelper,
                        helperTarget: options.helperTarget,
                      },
                    ),
              ),
            ),
        options.signal,
      ),
    waitForExit: Effect.fnUntraced(function* (service): Effect.fn.Return<
      CompletionWaitResult,
      ProviderError
    > {
      const nativeId = startedIds.get(service.name);
      if (nativeId === undefined) return { dependencyUnavailable: { reason: "missing" } };
      const waited = yield* waitNativeContainer(nativeId, {
        api,
        ctx: options.ctx,
        dialect: (options.dialect ?? libpodLifecycleDialect).wait,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }).pipe(
        Effect.onInterrupt(() =>
          stopCompletionJob(deps, {
            appId: plan.id,
            providerId: plan.provider,
            service: service.name,
            containerId: nativeId,
          }).pipe(Effect.catchCause((cause) => Effect.failCause(annotateFailureRole(cause, "cleanup")))),
        ),
      );
      if (waited._tag === "Missing") return { dependencyUnavailable: { reason: "missing" } };
      // The completion verdict is final, so a slow engine gets the whole inspect rather than a sampling bound.
      const inspected = yield* sanitizeDependencyInspect(
        deps,
        inspectStartedContainer(deps, { plan, service, nativeId }),
      );
      if (inspected._tag === "Unavailable") return { dependencyUnavailable: { reason: inspected.reason } };
      const observed = inspected.state;
      if (observed.status === "dead") {
        return { dependencyExit: { status: "dead", containerId: nativeId } };
      }
      if (observed.status === "exited") {
        const exitCode = observed.exitCode;
        // Conflicting wait/inspect codes cannot prove completion.
        if (exitCode !== undefined && exitCode !== waited.exitCode) {
          return { dependencyUnavailable: { reason: "unverified" } };
        }
        return {
          dependencyExit: {
            status: "exited",
            containerId: nativeId,
            ...(exitCode === undefined ? {} : { exitCode }),
          },
        };
      }
      return { dependencyUnavailable: { reason: "unverified" } };
    }),
  }).pipe(
    Effect.catchCause((cause) => {
      const [reason] = cause.reasons;
      return cause.reasons.length === 1 && reason?._tag === "Fail"
        ? captureStartFailure(deps, plan, reason.error)
        : Effect.failCause(cause);
    }),
  );

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
    const exit = blocked.dependencyExit;
    const exitCode = exit === undefined ? blocked.lastExitCode : exit.exitCode;
    const diagnoseListener =
      exit === undefined &&
      blocked.dependencyUnavailable === undefined &&
      blocked.unmetGate.endsWith(":healthy");
    const capture =
      aborted || dependency === undefined || blocked.dependencyUnavailable !== undefined
        ? Effect.succeed(undefined)
        : captureServiceLogTail(deps, plan, dependency, {
            ...(exit === undefined ? {} : { containerId: exit.containerId }),
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(blocked.timedOut === true ? { timedOut: true } : {}),
          });
    const observation =
      aborted || dependency === undefined || !diagnoseListener
        ? Effect.succeed(undefined)
        : observeTcpListener(dependency, (command) =>
            execStream(plan, { app: plan.id, service: dependency.name, plan }, command, {
              api,
              ctx: options.ctx,
            }),
          );
    return yield* Effect.all([Effect.exit(capture), observation], { concurrency: "unbounded" }).pipe(
      Effect.flatMap(([captured, listener]): Effect.Effect<never, BringUpError> => {
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
        const diagnostic =
          listener !== undefined && dependency !== undefined
            ? listenerDiagnostic(listener, dependency)
            : undefined;
        const action =
          diagnostic?.action ?? (diagnoseListener ? listenerAuthorityAction(dependency) : undefined);
        const unavailable = blocked.dependencyUnavailable;
        const exitMessage =
          exit === undefined
            ? unavailable === undefined
              ? ""
              : `Dependency ${blocked.dependency} was ${unavailable.reason}. `
            : `Dependency ${blocked.dependency} ${exit.status === "dead" ? "is dead" : "exited"}${exit.exitCode === undefined ? "" : ` with code ${exit.exitCode}`}. `;
        const logTail = Exit.isSuccess(captured) ? captured.value : undefined;
        const details =
          exit !== undefined
            ? dependencyExitDetails(blocked.dependency, blocked.unmetGate, exit)
            : unavailable !== undefined
              ? {
                  dependencyUnavailable: {
                    service: blocked.dependency,
                    gate: blocked.unmetGate,
                    reason: unavailable.reason,
                  },
                }
              : blocked.lastError === undefined
                ? undefined
                : { readinessFailure: blocked.lastError };
        const error = podmanFailure(deps, {
          service,
          operation: "bringUp.schedule",
          message: `${exitMessage}${diagnostic === undefined ? "" : `Dependency ${blocked.dependency}: ${diagnostic.finding}. `}Service ${blocked.service} could not start because dependency gate ${blocked.unmetGate} was not satisfied.`,
          remediation: `${action === undefined ? "" : `${deps.redactor.redactString(action)}\n`}${diagnostic?.authority === undefined ? "" : `${deps.redactor.redactString(diagnostic.authority)}\n`}${dependencyGateRemediation(plan, blocked.dependency)}`,
          ...(listener === undefined ? {} : { listener }),
          ...(details === undefined ? {} : { details }),
          ...(logTail === undefined ? {} : { logTail }),
        });
        return Exit.isFailure(captured)
          ? Effect.failCause(mergeFailure(Cause.fail(error), captured.cause, "cleanup"))
          : Effect.fail(error);
      }),
    );
  }

  return {
    changed: result.changed || staleNameChanged || createdVolumes.length > 0,
    createdVolumes,
    ...(deps.changes.size === 0 ? {} : { services: Object.fromEntries(deps.changes) }),
  };
});
