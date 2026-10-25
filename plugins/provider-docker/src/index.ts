import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  isDockerApiVersionError,
  makeDockerApiClient as makeRuntimeDockerApiClient,
} from "@lando/container-runtime/docker/api-client";
import { APP_LABEL, APP_ROOT_LABEL, SCRATCH_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
import { inspectEngineResourceNames } from "@lando/container-runtime/resource-names";

import {
  type HostProxyContainerTarget,
  buildProviderCapabilities,
  decodeProviderCapabilitiesFor,
  engineInfoArchitecture,
  hostProxyCapabilities,
  hostProxyContainerTargets,
} from "@lando/container-runtime/capabilities";
import { volumeCreationLabels } from "@lando/container-runtime/data-plane";
import {
  dockerLifecycleDialect,
  dockerPullDialect,
  dockerWaitDialect,
} from "@lando/container-runtime/dialect";
import type { ProviderErrorContext } from "@lando/container-runtime/engine-api";
import { apiResponseFailure, parseEngineJson } from "@lando/container-runtime/engine-errors";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { makeEnsureImage } from "@lando/container-runtime/image-ensure";
import { pullImage } from "@lando/container-runtime/image-pull";
import {
  type ResolveContainerHelper,
  makeProviderLogSourceBinding,
} from "@lando/container-runtime/log-source-binding";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { bringDown } from "@lando/container-runtime/podman/bring-down";
import {
  type BringUpOptions,
  type StartFailureRemediation,
  bringUp,
  isMissingImageCreateResponse,
} from "@lando/container-runtime/podman/bring-up";
import type {
  EmitComposeResult,
  EmitComposeOptions as RuntimeEmitComposeOptions,
} from "@lando/container-runtime/podman/compose";
import { composeKnobsForDialect } from "@lando/container-runtime/podman/compose-knobs";
import { exec, execStream } from "@lando/container-runtime/podman/exec";
import { inspect, publicationObservationFromInspect } from "@lando/container-runtime/podman/inspect";
import { containerConsoleLogs, logs } from "@lando/container-runtime/podman/logs";
import {
  bindResolvedProviderOps,
  composeAdaptersFor,
  forgetAppliedPlanUnlessKept,
  makeProviderPlanState,
  makeResourceOwnershipStore,
  notImplementedError,
  providerHostInputs,
  rememberAppliedPlan,
} from "@lando/container-runtime/provider-assembly";
import {
  redactDetails,
  redactString,
  runtimeDiagnosticContext,
  withApiReason,
} from "@lando/container-runtime/redact";
import { readAppEnvironment } from "@lando/container-runtime/runtime-provider";
import {
  DESTROYED,
  DESTROY_NO_OP,
  observedRemoval,
  postExactServiceLifecycle,
  postServiceLifecycle,
  removeObservedContainer,
} from "@lando/container-runtime/service-lifecycle";
import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import { waitForExit } from "@lando/container-runtime/wait-for-exit";
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect";

import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LogFileAccess } from "@lando/sdk/log-follow";
import { type PluginStateStore, definePlugin } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
  hostPlatformFamily,
} from "@lando/sdk/schema";
import {
  PathsService,
  RuntimeProvider,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";

import { AGENT_RELAY_IMAGE, makeDockerDesktopAgentSocketBridge } from "./agent-socket-relay.ts";
import { listAppliedPlans, loadAppliedPlan, persistAppliedPlan, removeAppliedPlan } from "./applied-state.ts";
import { makeIptablesForwardCheck } from "./iptables-forward-check.ts";

export {
  appliedPlanPath,
  appliedPlansDir,
  listAppliedPlans,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "./applied-state.ts";
export type {
  DockerApiClient,
  DockerHttpRequest,
  DockerHttpResponse,
} from "@lando/container-runtime/docker/api-client";
export { scratchLabelsForPlan } from "@lando/container-runtime/podman/bring-up";

export const PLUGIN_NAME = "@lando/provider-docker" as const;

const PROVIDER_ID = "docker";

const DOCKER_CTX: ProviderErrorContext = {
  providerId: "docker",
  remediation:
    "Run `lando doctor --provider=docker` to inspect the Docker provider, then retry `lando start`.",
};

const IMAGE_MISSING_REMEDIATION =
  "The image is not present on this Docker engine and could not be pulled. Run `lando doctor --provider=docker` to inspect the Docker provider, then retry `lando start`.";

export interface ProviderLayerOptions {
  readonly dockerApi?: DockerApiClient;
  readonly dockerApiFactory?: (dockerHost: string) => DockerApiClient;
  readonly dockerHost?: string;
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly eventService?: BringUpOptions["eventService"];
  readonly logFileAccess?: LogFileAccess;
  readonly resolveContainerHelper?: ResolveContainerHelper;
  readonly appliedPlanState?: PluginStateStore;
  readonly appliedPlanStateDir?: string;
  readonly sanitizeAppliedPlan?: (plan: AppPlan) => AppPlan;
}

export interface ResolveDockerHostOptions {
  readonly dockerHost?: string;
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type EmitComposeOptions = Omit<RuntimeEmitComposeOptions, "ctx">;
export type { EmitComposeResult };

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

const unavailable = (
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
  remediation?: string,
) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: redactString(withApiReason(message, details)),
    ...(details === undefined ? {} : { details: redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
    remediation:
      remediation ??
      `Install or start Docker and confirm it can perform \`${operation}\`, then re-run the command.`,
  });

const internal = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation,
    message: redactString(message),
    ...(details === undefined ? {} : { details: redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
    remediation: `Re-run the command after checking Docker logs for the \`${operation}\` failure; if it persists, report the error with that operation name.`,
  });

const missingApi = (operation: string) =>
  unavailable(
    operation,
    `provider-docker ${operation} requires a Docker API client.`,
    undefined,
    undefined,
    `Ensure the Docker engine API is reachable, then retry \`${operation}\`.`,
  );

const parseJson = (
  response: DockerHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
    catch: (cause) => internal(operation, "Docker API returned malformed JSON.", response, cause),
  });

const request = Effect.fn("DockerApi.request")(
  (
    api: DockerApiClient,
    operation: string,
    input: DockerHttpRequest,
  ): Effect.Effect<DockerHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
    api.request === undefined ? Effect.fail(missingApi(operation)) : api.request(input),
);

const unixSocketPath = (dockerHost: string) =>
  dockerHost.startsWith("unix://") ? dockerHost.slice("unix://".length) : dockerHost;

export const isNpipeDockerHost = (dockerHost: string): boolean => dockerHost.startsWith("npipe:");

export const npipeSocketPath = normalizeNamedPipePath;

const isVmMediatedDockerHost = (platform: HostPlatform, dockerHost: string): boolean => {
  const family = hostPlatformFamily(platform);
  if (family === "darwin" || family === "win32") return true;
  const socketPath = unixSocketPath(dockerHost);
  return (
    dockerHost.startsWith("tcp://") ||
    dockerHost.startsWith("http://") ||
    dockerHost.startsWith("https://") ||
    socketPath.includes("/.docker/desktop/") ||
    socketPath.includes("/.docker/run/")
  );
};

export const dockerCapabilitiesForHost = (
  platform: HostPlatform,
  dockerHost: string,
  containerTargets: ReadonlyArray<HostProxyContainerTarget> = [],
): ProviderCapabilities =>
  buildProviderCapabilities({
    bindMounts: true,
    artifactBuild: true,
    artifactPull: true,
    bindMountPerformance: isVmMediatedDockerHost(platform, dockerHost) ? "slow" : "native",
    volumeSnapshot: "none",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "none",
    rootless: false,
    architectureEmulation: platform === "darwin" || platform === "win32",
    composeSpec: "native",
    composeKnobs: { supported: composeKnobsForDialect("docker") },
    composeServiceFields: { supported: ["labels", "configs"] },
    composeProjectFields: { supported: ["configs"] },
    providerExtensions: [],
    hostProxy: hostProxyCapabilities(platform, containerTargets, "host.docker.internal"),
    agentSocket: {
      delivery: isVmMediatedDockerHost(platform, dockerHost) ? "volume-relay" : "bind-directory",
    },
  });

export const dockerCapabilitiesForPlatform = (platform: HostPlatform): ProviderCapabilities =>
  dockerCapabilitiesForHost(platform, "/var/run/docker.sock");

export const linuxDockerCapabilities = dockerCapabilitiesForHost("linux", "/var/run/docker.sock");
export const macosDockerCapabilities = dockerCapabilitiesForHost("darwin", "/var/run/docker.sock");
export const windowsDockerCapabilities = dockerCapabilitiesForHost("win32", "npipe://./pipe/docker_engine");

export const decodeProviderCapabilities = decodeProviderCapabilitiesFor(PROVIDER_ID);

export const introspectProviderCapabilities = (
  api: DockerApiClient,
  platform: HostPlatform,
  dockerHost = "/var/run/docker.sock",
): Effect.Effect<ProviderCapabilities, ProviderCapabilityError | ProviderUnavailableError> =>
  api.info.pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderInternalError
        ? new ProviderCapabilityError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: "Docker API info inspection failed.",
            capability: "docker-info",
            requiredValue: "Docker info response",
            actualValue: undefined,
            cause,
            remediation:
              "Choose a provider that supports `docker-info`, or remove that requirement from the app.",
          })
        : cause,
    ),
    Effect.map((info) => {
      const engineArch = engineInfoArchitecture(info);
      return dockerCapabilitiesForHost(platform, dockerHost, hostProxyContainerTargets(engineArch));
    }),
  );

export const makeDockerApiClient = (
  dockerHost = process.env.DOCKER_HOST ?? "/var/run/docker.sock",
): DockerApiClient => makeRuntimeDockerApiClient(dockerHost, DOCKER_CTX);

export const resolveDockerHost = (options: ResolveDockerHostOptions = {}): string => {
  const env = options.env ?? process.env;
  if (options.dockerHost !== undefined) return options.dockerHost;
  if (options.platform === undefined) {
    throw unavailable("select", "provider-docker host resolution requires the resolved host platform.");
  }
  const family = hostPlatformFamily(options.platform);
  if (family === "win32" && env.LANDO_TEST_WINDOWS_DOCKER_SOCKET !== undefined) {
    return env.LANDO_TEST_WINDOWS_DOCKER_SOCKET;
  }
  if (env.LANDO_TEST_DOCKER_SOCKET !== undefined) return env.LANDO_TEST_DOCKER_SOCKET;
  if (env.DOCKER_HOST !== undefined) return env.DOCKER_HOST;
  if (family === "win32") return "npipe://./pipe/docker_engine";
  if (family === "linux" && env.HOME !== undefined && env.LANDO_DOCKER_DESKTOP === "1") {
    return `${env.HOME}/.docker/desktop/docker.sock`;
  }
  return "/var/run/docker.sock";
};

export const { renderCompose, emitCompose, composePath } = composeAdaptersFor(DOCKER_CTX);

const dockerEnsureImage = (api: DockerApiClient): NonNullable<BringUpOptions["ensureImage"]> =>
  makeEnsureImage(api, { ctx: DOCKER_CTX, dialect: dockerPullDialect });

const isMissingImageDetails = (details: unknown): boolean => {
  if (typeof details !== "object" || details === null) return false;
  const retryStatus = Reflect.get(details, "retryStatus");
  const retryBody = Reflect.get(details, "retryBody");
  if (typeof retryStatus === "number" || typeof retryBody === "string") {
    return isMissingImageCreateResponse({
      status: typeof retryStatus === "number" ? retryStatus : 0,
      body: typeof retryBody === "string" ? retryBody : "",
    });
  }
  const status = Reflect.get(details, "status");
  const body = Reflect.get(details, "body");
  return isMissingImageCreateResponse({
    status: typeof status === "number" ? status : 0,
    body: typeof body === "string" ? body : "",
  });
};

const dockerStartFailureRemediation: StartFailureRemediation = ({ operation, details }) =>
  operation === "bringUp.create" && isMissingImageDetails(details) ? IMAGE_MISSING_REMEDIATION : undefined;

interface DiscoveredContainer {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: string;
  readonly startedAt?: string;
}

const discoverContainers = Effect.fn("DockerApi.discoverContainers")(function* (
  api: DockerApiClient,
  labelFilter?: string,
  ctx: ProviderErrorContext = DOCKER_CTX,
) {
  const filters = labelFilter === undefined ? {} : { label: [labelFilter] };
  const params = new URLSearchParams({
    all: "true",
    filters: JSON.stringify(filters),
  });

  const response = yield* request(api, "list", {
    method: "GET",
    path: `/containers/json?${params}` as `/${string}`,
  });

  if (response.status < 200 || response.status >= 300) {
    yield* Effect.fail(
      apiResponseFailure(ctx, "list", response, `Docker container list failed with HTTP ${response.status}.`),
    );
  }

  const body = yield* parseEngineJson(response, ctx, "list", {
    message: "Docker API returned malformed JSON.",
    details: redactDetails(response, ctx.redactor),
  });
  const containers = Array.isArray(body) ? body : [];

  return containers
    .map((container: unknown): DiscoveredContainer | undefined => {
      if (typeof container !== "object" || container === null) return undefined;
      const obj = container as {
        Id?: unknown;
        Names?: unknown;
        Labels?: unknown;
        State?: unknown;
        Status?: unknown;
      };

      if (typeof obj.Id !== "string" || !Array.isArray(obj.Names)) return undefined;
      const name = obj.Names[0];
      if (typeof name !== "string") return undefined;

      const labels =
        typeof obj.Labels === "object" && obj.Labels !== null ? (obj.Labels as Record<string, unknown>) : {};

      // In /containers/json, State is a string like "running" or "exited"
      const state = typeof obj.State === "string" ? obj.State : "unknown";

      // Status contains more info like "Up 5 minutes"
      const status = typeof obj.Status === "string" ? obj.Status : undefined;

      return {
        id: obj.Id,
        name: name.startsWith("/") ? name.slice(1) : name,
        labels: Object.fromEntries(
          Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        state,
        ...(status === undefined ? {} : { startedAt: status }),
      };
    })
    .filter((container): container is DiscoveredContainer => container !== undefined);
});

const makeUnavailable = (operation: string) => notImplementedError(PROVIDER_ID, operation);

export const makeRuntimeProvider = Effect.fnUntraced(function* (options: ProviderLayerOptions = {}) {
  const ctx = yield* runtimeDiagnosticContext(DOCKER_CTX);
  return yield* makeRuntimeProviderWithContext(options, ctx);
});

const makeRuntimeProviderWithContext = (options: ProviderLayerOptions, DOCKER_CTX: ProviderErrorContext) => {
  if (options.platform === undefined) {
    return Effect.fail(
      unavailable("select", "provider-docker construction requires the resolved host platform."),
    );
  }
  const platform = options.platform;
  const resolvedDockerHost = resolveDockerHost({
    platform,
    ...(options.dockerHost === undefined ? {} : { dockerHost: options.dockerHost }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const dockerApi =
    options.dockerApi ??
    (options.dockerApiFactory === undefined
      ? makeRuntimeDockerApiClient(resolvedDockerHost, DOCKER_CTX)
      : options.dockerApiFactory(resolvedDockerHost));
  const defaultFactoryConstruction =
    options.dockerApi === undefined && options.dockerApiFactory === undefined;
  const capabilities = introspectProviderCapabilities(dockerApi, platform, resolvedDockerHost).pipe(
    Effect.catch((failure) =>
      defaultFactoryConstruction
        ? Effect.succeed(dockerCapabilitiesForHost(platform, resolvedDockerHost))
        : Effect.fail(failure),
    ),
  );
  const runtimeCapabilities = capabilities.pipe(
    Effect.map((resolved) => {
      const logSourceBinding = makeProviderLogSourceBinding({
        ...(DOCKER_CTX.redactor === undefined ? {} : { redactor: DOCKER_CTX.redactor }),
        providerId: PROVIDER_ID,
        logFileAccess: options.logFileAccess,
        helperTarget: resolved.hostProxy?.containerTargets[0],
        resolveHelper: options.resolveContainerHelper,
      });
      return {
        capabilities: {
          ...resolved,
          serviceLogSources: logSourceBinding.supported && resolved.serviceLogSources,
        },
        logSourceBinding,
      };
    }),
  );
  return Effect.gen(function* () {
    const { capabilities: resolvedCapabilities, logSourceBinding } = yield* runtimeCapabilities;
    const planState = makeProviderPlanState({
      ctx: DOCKER_CTX,
      providerId: ProviderId.make(PROVIDER_ID),
      endpointNamespace: resolvedDockerHost,
      pullHelperImage: (ref) =>
        pullImage(dockerApi, ref, {
          ctx: DOCKER_CTX,
          dialect: dockerPullDialect,
          policy: "missing",
        }),
      api: dockerApi,
      capabilities: resolvedCapabilities,
      redactDetails: (value) => redactDetails(value, DOCKER_CTX.redactor),
      volumeCreationLabels,
      providerName: "Docker",
      ...(options.appliedPlanState === undefined ? {} : { appliedPlanState: options.appliedPlanState }),
      ...(options.sanitizeAppliedPlan === undefined
        ? {}
        : { sanitizeAppliedPlan: options.sanitizeAppliedPlan }),
      load: loadAppliedPlan,
      persist: persistAppliedPlan,
      remove: removeAppliedPlan,
    });
    const { appliedPlans } = planState;
    const resolvePlan = (target: {
      readonly app: AppId;
      readonly plan?: AppPlan;
    }): Effect.Effect<AppPlan | undefined, never> =>
      target.plan === undefined ? appliedPlans.resolvePlan(target.app) : Effect.succeed(target.plan);

    const resolvedOps = bindResolvedProviderOps(planState, {
      ctx: DOCKER_CTX,
      readAppEnvironment: (target, names) =>
        readAppEnvironment(target, names, { api: dockerApi, ctx: DOCKER_CTX }),
      noPlanError: (_app, operation) => makeUnavailable(operation),
      service: {
        lifecycle: (plan, target, action) =>
          postServiceLifecycle(plan, target, action, { api: dockerApi, ctx: DOCKER_CTX }),
        resume: (target, identity) =>
          postExactServiceLifecycle(target, identity, "start", { api: dockerApi, ctx: DOCKER_CTX }),
        suspend: (target, identity) =>
          postExactServiceLifecycle(target, identity, "stop", { api: dockerApi, ctx: DOCKER_CTX }),
        waitForExit: (plan, target, waitOptions) =>
          waitForExit(plan, target, {
            api: dockerApi,
            ctx: DOCKER_CTX,
            dialect: dockerWaitDialect,
            ...(waitOptions?.signal === undefined ? {} : { signal: waitOptions.signal }),
          }),
        exec: (plan, target, command) => exec(plan, target, command, { api: dockerApi, ctx: DOCKER_CTX }),
        execStream: (plan, target, command) =>
          execStream(plan, target, command, { api: dockerApi, ctx: DOCKER_CTX }),
        inspect: (plan, target) => inspect(plan, target, { api: dockerApi, ctx: DOCKER_CTX }),
      },
    });

    return {
      id: PROVIDER_ID,
      inspectResourceNames: Effect.fn("RuntimeProvider.inspectResourceNames")((query) =>
        inspectEngineResourceNames(dockerApi, query, DOCKER_CTX),
      ),
      displayName: "Docker Runtime Provider",
      version: "0.0.0",
      platform,
      capabilities: resolvedCapabilities,
      ...(isVmMediatedDockerHost(platform, resolvedDockerHost)
        ? {
            openAgentSocketBridge: makeDockerDesktopAgentSocketBridge({
              api: dockerApi,
              hostGateway: "host.docker.internal",
              relayImage: AGENT_RELAY_IMAGE,
            }),
          }
        : {}),
      isAvailable: dockerApi.info.pipe(
        Effect.as(true),
        Effect.catch((error) =>
          isDockerApiVersionError(error) ? Effect.fail(error) : Effect.succeed(false),
        ),
      ),
      appliedPlans:
        options.appliedPlanState === undefined || options.appliedPlanStateDir === undefined
          ? Effect.succeed([])
          : listAppliedPlans(options.appliedPlanState, options.appliedPlanStateDir),
      planSetup: Effect.fn("RuntimeProvider.planSetup")(() =>
        Effect.succeed({ providerId: ProviderId.make(PROVIDER_ID), changes: [] }),
      ),
      setup: Effect.fn("RuntimeProvider.setup")(() => Effect.void),
      getStatus: dockerApi.info.pipe(
        Effect.as({ running: true, message: "ready" }),
        Effect.catch((error) =>
          Effect.succeed({
            running: false,
            message: error instanceof Error ? error.message : "Docker Engine is not reachable.",
          }),
        ),
      ),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: Effect.fn("RuntimeProvider.buildArtifact")((spec) =>
        buildContainerArtifact(spec, { providerId: PROVIDER_ID, api: dockerApi }),
      ),
      pullArtifact: Effect.fn("RuntimeProvider.pullArtifact")((spec) =>
        pullImage(dockerApi, spec.ref, {
          ctx: DOCKER_CTX,
          dialect: dockerPullDialect,
          ...(spec.policy === undefined ? {} : { policy: spec.policy }),
        }).pipe(
          Effect.map((result) => ({
            providerId: ProviderId.make(PROVIDER_ID),
            ref: result.ref,
            ...(result.digest === undefined ? {} : { digest: result.digest }),
          })),
        ),
      ),
      removeArtifact: Effect.fn("RuntimeProvider.removeArtifact")(() => Effect.void),
      apply: Effect.fn("RuntimeProvider.apply")(function* (plan, applyOptions) {
        yield* planState.ownership.prepare(plan, yield* appliedPlans.resolvePlan(plan.id));
        return yield* bringUp(plan, {
          api: dockerApi,
          ctx: DOCKER_CTX,
          dialect: dockerLifecycleDialect,
          ensureImage: dockerEnsureImage(dockerApi),
          retryCreateOnMissingImage: true,
          startFailureRemediation: dockerStartFailureRemediation,
          platform,
          daemonUrl: resolvedDockerHost,
          ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
          ...(applyOptions.resolveServiceEnvironment === undefined
            ? {}
            : { resolveServiceEnvironment: applyOptions.resolveServiceEnvironment }),
          reconcile: applyOptions.reconcile,
          onVolumeCreated: applyOptions.onVolumeCreated,
          ...(applyOptions.forbidRecreate === true ? { forbidRecreate: true } : {}),
          completionPlan: applyOptions.completionPlan ?? applyOptions.recordedPlan ?? plan,
          ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
        }).pipe(Effect.tap(() => rememberAppliedPlan(appliedPlans, plan, applyOptions)));
      }),
      ...resolvedOps,
      cleanupOwnedResources: planState.cleanupOwnedResources,
      destroy: Effect.fn("RuntimeProvider.destroy")(function* (target, destroyOptions) {
        return yield* resolvePlan(target).pipe(
          Effect.flatMap((plan) =>
            plan === undefined
              ? Effect.succeed(DESTROY_NO_OP)
              : bringDown(plan, {
                  api: dockerApi,
                  ctx: DOCKER_CTX,
                  dialect: dockerLifecycleDialect,
                  volumes: destroyOptions.volumes,
                  ...(destroyOptions.purgeCaches === undefined
                    ? {}
                    : { purgeCaches: destroyOptions.purgeCaches }),
                }).pipe(
                  Effect.tap(() => forgetAppliedPlanUnlessKept(appliedPlans, target.app, destroyOptions)),
                  Effect.as(DESTROYED),
                ),
          ),
        );
      }),
      removeObservedService: Effect.fn("RuntimeProvider.removeObservedService")((observed) =>
        removeObservedContainer(observed, { api: dockerApi, ctx: DOCKER_CTX }).pipe(
          Effect.map(observedRemoval),
        ),
      ),
      logs: (target, logOptions) =>
        Stream.unwrap(
          resolvePlan(target).pipe(
            Effect.map((plan) => {
              if (plan !== undefined) {
                const service = plan.services[target.service];
                return logs(plan, target, logOptions, {
                  api: dockerApi,
                  ctx: DOCKER_CTX,
                  ...logSourceBinding.bind(
                    dockerApi,
                    service === undefined ? undefined : containerName(plan, service),
                  ),
                });
              }

              return Stream.fromEffect(
                discoverContainers(dockerApi, APP_LABEL, DOCKER_CTX).pipe(
                  Effect.flatMap((containers) => {
                    const container = containers.find(
                      (c) => c.labels[APP_LABEL] === target.app && c.labels[SERVICE_LABEL] === target.service,
                    );
                    if (container === undefined) {
                      return Effect.fail(
                        unavailable(
                          "logs",
                          `Container for app ${target.app} service ${target.service} not found.`,
                        ),
                      );
                    }
                    return Effect.succeed(container);
                  }),
                ),
              ).pipe(
                Stream.flatMap((container) =>
                  containerConsoleLogs(dockerApi, DOCKER_CTX, container.name, target.service, logOptions),
                ),
              );
            }),
          ),
        ),
      list: Effect.fn("RuntimeProvider.list")((filter) =>
        discoverContainers(dockerApi, APP_LABEL, DOCKER_CTX).pipe(
          Effect.flatMap((containers) =>
            Effect.forEach(
              containers.filter((container) => {
                const appId = container.labels[APP_LABEL];
                if (appId === undefined) return false;
                if (filter.app !== undefined && appId !== filter.app) return false;
                if (
                  filter.includeScratch !== true &&
                  filter.app === undefined &&
                  container.labels[SCRATCH_LABEL] === "TRUE"
                ) {
                  return false;
                }
                return true;
              }),
              (container) =>
                Effect.gen(function* () {
                  const appId = container.labels[APP_LABEL] ?? "";
                  const serviceName = container.labels[SERVICE_LABEL] ?? "";
                  const isRunning = container.state === "running";
                  const status = isRunning ? "running" : "stopped";

                  const inspectResponse = yield* request(dockerApi, "list", {
                    method: "GET",
                    path: `/containers/${encodeURIComponent(container.name)}/json`,
                  });

                  let publications: ServiceRuntimeInfo["publications"] = { status: "unknown" };
                  if (inspectResponse.status >= 200 && inspectResponse.status < 300) {
                    publications = publicationObservationFromInspect(
                      yield* parseJson(inspectResponse, "list"),
                    );
                  } else if (inspectResponse.status === 404) {
                    publications = { status: "missing" };
                  }

                  return {
                    app: AppId.make(appId),
                    ...(container.labels[APP_ROOT_LABEL] === undefined
                      ? {}
                      : { appRoot: AbsolutePath.make(container.labels[APP_ROOT_LABEL]) }),
                    service: ServiceName.make(serviceName),
                    providerId: ProviderId.make(PROVIDER_ID),
                    status,
                    state: container.state,
                    containerId: container.id,
                    labels: container.labels,
                    publications,
                    ...(container.startedAt === undefined
                      ? {}
                      : {
                          lastStartedAt: Option.match(DateTime.make(container.startedAt), {
                            onSome: DateTime.toDate,
                            // Preserve the invalid Date returned for Docker's relative Status text.
                            onNone: () =>
                              DateTime.toDate(
                                DateTime.mapEpochMillis(DateTime.makeUnsafe(0), () => Number.NaN),
                              ),
                          }),
                        }),
                  };
                }),
            ),
          ),
        ),
      ),
    } satisfies RuntimeProviderShape;
  });
};

export const layer = (options: ProviderLayerOptions = {}) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

export const layerDefault = layer();

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Reference Docker RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: [PROVIDER_ID] },
  entry: "./src/index.ts",
});

const runtimeProviderId = ProviderId.make(PROVIDER_ID);

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  runtimeProviders: new Map([
    [
      runtimeProviderId,
      {
        id: runtimeProviderId,
        resourceOwnership: (ctx, root) =>
          makeResourceOwnershipStore(PROVIDER_ID, ctx.stateStore).summary(root),
        appliedPlans: (ctx) =>
          Effect.flatMap(PathsService, (paths) =>
            listAppliedPlans(ctx.stateStore, paths.pluginStateDir(PLUGIN_NAME)),
          ),
        make: Effect.fn("RuntimeProvider.make")(function* (ctx) {
          const { paths, platform, resolveContainerHelper, sanitizeAppliedPlan, eventService } =
            yield* providerHostInputs;
          return yield* makeRuntimeProvider({
            platform,
            ...(eventService === undefined ? {} : { eventService }),
            resolveContainerHelper,
            appliedPlanState: ctx.stateStore,
            appliedPlanStateDir: paths.pluginStateDir(PLUGIN_NAME),
            sanitizeAppliedPlan,
          });
        }),
      },
    ],
  ]),
  doctorChecks: [makeIptablesForwardCheck()],
});
