import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  makeDockerApiClient as makeRuntimeDockerApiClient,
} from "@lando/container-runtime/docker/api-client";
import { APP_LABEL, APP_ROOT_LABEL, SCRATCH_LABEL, SERVICE_LABEL } from "@lando/container-runtime/labels";
import { inspectEngineResourceNames } from "@lando/container-runtime/resource-names";

import { makeAppliedPlanCache } from "@lando/container-runtime/applied-plan-cache";
import {
  type HostProxyContainerTarget,
  buildProviderCapabilities,
  engineInfoArchitecture,
  hostProxyCapabilities,
  hostProxyContainerTargets,
} from "@lando/container-runtime/capabilities";
import {
  VOLUME_WITNESS_IMAGE,
  makeProviderDataPlane,
  volumeCreationLabels,
} from "@lando/container-runtime/data-plane";
import {
  dockerLifecycleDialect,
  dockerPullDialect,
  dockerWaitDialect,
} from "@lando/container-runtime/dialect";
import type { ProviderErrorContext } from "@lando/container-runtime/engine-api";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { makeEnsureImage } from "@lando/container-runtime/image-ensure";
import { pullImage } from "@lando/container-runtime/image-pull";
import { makeDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import {
  type LogFileHelperPayloads,
  logFileHelperPayloadForTargets,
} from "@lando/container-runtime/log-file-helper-payloads";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { bringDown } from "@lando/container-runtime/podman/bring-down";
import {
  type BringUpOptions,
  type StartFailureRemediation,
  bringUp,
  isMissingImageCreateResponse,
} from "@lando/container-runtime/podman/bring-up";
import {
  type EmitComposeResult,
  type EmitComposeOptions as RuntimeEmitComposeOptions,
  composePath as runtimeComposePath,
  emitCompose as runtimeEmitCompose,
  renderCompose as runtimeRenderCompose,
} from "@lando/container-runtime/podman/compose";
import { exec, execStream } from "@lando/container-runtime/podman/exec";
import { inspect, publishedEndpointsFromInspect } from "@lando/container-runtime/podman/inspect";
import { logs } from "@lando/container-runtime/podman/logs";
import { redactDetails, withApiReason } from "@lando/container-runtime/redact";
import { makeResolvedProviderOps } from "@lando/container-runtime/runtime-provider";
import {
  DESTROYED,
  DESTROY_NO_OP,
  observedRemoval,
  postExactServiceLifecycle,
  postServiceLifecycle,
  removeObservedContainer,
} from "@lando/container-runtime/service-lifecycle";
import { makeLogDecoder as makeRuntimeLogDecoder } from "@lando/container-runtime/streams";
import { normalizeNamedPipePath } from "@lando/container-runtime/transport";
import { waitForExit } from "@lando/container-runtime/wait-for-exit";
import { Effect, Layer, Schema, Stream } from "effect";

import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LogFileAccess } from "@lando/sdk/log-follow";
import { type PluginStateStore, definePlugin } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
  hostPlatformFamily,
} from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  EventService,
  type FileSystem,
  type LogChunk,
  LogFileHelperAssets,
  type LogOptions,
  type LogTarget,
  PathsService,
  type ProviderError,
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
  readonly logFileHelperPayloads?: LogFileHelperPayloads;
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
    message: withApiReason(message, details),
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
    ...(remediation === undefined ? {} : { remediation }),
  });

const internal = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const missingApi = (operation: string) =>
  unavailable(operation, `provider-docker ${operation} requires a Docker API client.`);

const parseJson = (
  response: DockerHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
    catch: (cause) => internal(operation, "Docker API returned malformed JSON.", response, cause),
  });

const request = (
  api: DockerApiClient,
  operation: string,
  input: DockerHttpRequest,
): Effect.Effect<DockerHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  api.request === undefined ? Effect.fail(missingApi(operation)) : api.request(input);

const stream = (
  api: DockerApiClient,
  operation: string,
  input: DockerHttpRequest,
): Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError> =>
  api.stream === undefined ? Stream.fail(missingApi(operation)) : api.stream(input);

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
    volumeSnapshot: "copy",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "none",
    rootless: false,
    architectureEmulation: platform === "darwin" || platform === "win32",
    composeSpec: "native",
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

export const decodeProviderCapabilities = (input: unknown) =>
  Schema.decodeUnknownEffect(ProviderCapabilities)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "provider-docker returned invalid ProviderCapabilities.",
          capability: "ProviderCapabilities",
          requiredValue: "@lando/sdk/schema ProviderCapabilities",
          actualValue: input,
          cause,
        }),
    ),
  );

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

export const renderCompose = (plan: AppPlan): string => runtimeRenderCompose(plan, DOCKER_CTX);

export const emitCompose = (
  plan: AppPlan,
  options: EmitComposeOptions,
): Effect.Effect<EmitComposeResult, ProviderInternalError, FileSystem> =>
  runtimeEmitCompose(plan, { ...options, ctx: DOCKER_CTX });

export const composePath = (plan: AppPlan, options: EmitComposeOptions): string =>
  runtimeComposePath(plan, { ...options, ctx: DOCKER_CTX });

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

const discoverContainers = (api: DockerApiClient, labelFilter?: string) =>
  Effect.gen(function* () {
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
        unavailable("list", `Docker container list failed with HTTP ${response.status}.`, response),
      );
    }

    const body = yield* parseJson(response, "list");
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
          typeof obj.Labels === "object" && obj.Labels !== null
            ? (obj.Labels as Record<string, unknown>)
            : {};

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

const parseLogLine = (service: ServicePlan, streamName: "stdout" | "stderr", line: string): LogChunk => {
  const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/u.exec(line);
  if (match === null) {
    return { service: service.name, stream: streamName, line };
  }
  const timestamp = new Date(match[1] ?? "");
  return Number.isNaN(timestamp.getTime())
    ? { service: service.name, stream: streamName, line }
    : { service: service.name, stream: streamName, line: match[2] ?? "", timestamp };
};

interface LogsRuntime {
  readonly api: DockerApiClient;
  readonly logFileAccess?: LogFileAccess;
}

const logsWithoutPlan = (
  containerNameOrId: string,
  serviceName: ServiceName,
  _target: LogTarget,
  options: Partial<LogOptions>,
  runtime: LogsRuntime,
): Stream.Stream<LogChunk, ProviderError> => {
  const query = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    follow: String(options.follow ?? true),
    timestamps: "true",
  });
  if (options.tail !== undefined) {
    query.set("tail", String(options.tail));
  }
  if (options.since !== undefined) {
    query.set("since", options.since);
  }

  return Stream.suspend(() => {
    const decodeChunk = makeRuntimeLogDecoder({
      parseLine: (streamName, line) => parseLogLine({ name: serviceName } as ServicePlan, streamName, line),
    });
    const consoleStream = stream(runtime.api, "logs", {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerNameOrId)}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));

    return consoleStream;
  });
};

const makeUnavailable = (operation: string) =>
  unavailable(operation, `provider-docker does not implement ${operation} yet.`);

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
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
    options.dockerApi ?? (options.dockerApiFactory ?? makeDockerApiClient)(resolvedDockerHost);
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
    Effect.map((resolved) => ({
      capabilities: {
        ...resolved,
        serviceLogSources:
          (options.logFileAccess !== undefined ||
            logFileHelperPayloadForTargets(
              options.logFileHelperPayloads,
              resolved.hostProxy?.containerTargets,
            ) !== undefined) &&
          resolved.serviceLogSources,
      },
      logFileHelperPayload: logFileHelperPayloadForTargets(
        options.logFileHelperPayloads,
        resolved.hostProxy?.containerTargets,
      ),
    })),
  );
  const dataPlane = makeProviderDataPlane({
    providerId: PROVIDER_ID,
    endpointNamespace: resolvedDockerHost,
    prepareWitnessImage: pullImage(dockerApi, VOLUME_WITNESS_IMAGE, {
      ctx: DOCKER_CTX,
      dialect: dockerPullDialect,
    }),
    api: dockerApi,
    snapshotMode: "copy",
    redactDetails,
    volumeCreationLabels,
  });

  const appliedPlans = makeAppliedPlanCache({
    providerId: ProviderId.make(PROVIDER_ID),
    providerName: "Docker",
    ...(options.appliedPlanState === undefined ? {} : { appliedPlanState: options.appliedPlanState }),
    ...(options.sanitizeAppliedPlan === undefined
      ? {}
      : { sanitizeAppliedPlan: options.sanitizeAppliedPlan }),
    load: loadAppliedPlan,
    persist: persistAppliedPlan,
    remove: removeAppliedPlan,
  });
  const resolvePlan = (target: {
    readonly app: AppId;
    readonly plan?: AppPlan;
  }): Effect.Effect<AppPlan | undefined, never> =>
    target.plan === undefined ? appliedPlans.resolvePlan(target.app) : Effect.succeed(target.plan);
  const rememberPlan = appliedPlans.rememberPlan;
  const forgetPlan = appliedPlans.forgetPlan;

  const resolvedOps = makeResolvedProviderOps({
    ctx: DOCKER_CTX,
    resolvePlan: (app) => resolvePlan({ app }),
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
    dataPlane,
  });

  return runtimeCapabilities.pipe(
    Effect.map(
      ({ capabilities: resolvedCapabilities, logFileHelperPayload }): RuntimeProviderShape => ({
        id: PROVIDER_ID,
        inspectResourceNames: (query) => inspectEngineResourceNames(dockerApi, query, DOCKER_CTX),
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
          Effect.catch(() => Effect.succeed(false)),
        ),
        appliedPlans:
          options.appliedPlanState === undefined || options.appliedPlanStateDir === undefined
            ? Effect.succeed([])
            : listAppliedPlans(options.appliedPlanState, options.appliedPlanStateDir),
        planSetup: () => Effect.succeed({ providerId: ProviderId.make(PROVIDER_ID), changes: [] }),
        setup: () => Effect.void,
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.succeed({ provider: "0.0.0" }),
        buildArtifact: (spec) => buildContainerArtifact(spec, { providerId: PROVIDER_ID, api: dockerApi }),
        pullArtifact: (spec) =>
          pullImage(dockerApi, spec.ref, { ctx: DOCKER_CTX, dialect: dockerPullDialect }).pipe(
            Effect.map((result) => ({
              providerId: ProviderId.make(PROVIDER_ID),
              ref: result.ref,
              ...(result.digest === undefined ? {} : { digest: result.digest }),
            })),
          ),
        removeArtifact: () => Effect.void,
        apply: (plan, applyOptions) =>
          bringUp(plan, {
            api: dockerApi,
            ctx: DOCKER_CTX,
            dialect: dockerLifecycleDialect,
            ensureImage: dockerEnsureImage(dockerApi),
            retryCreateOnMissingImage: true,
            startFailureRemediation: dockerStartFailureRemediation,
            platform,
            daemonUrl: resolvedDockerHost,
            ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
            ...(applyOptions.serviceEnvironment === undefined
              ? {}
              : { serviceEnvironment: applyOptions.serviceEnvironment }),
            reconcile: applyOptions.reconcile,
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
          }).pipe(Effect.tap(() => rememberPlan(applyOptions.recordedPlan ?? plan, applyOptions.reconcile))),
        ...resolvedOps,
        destroy: (target, destroyOptions) =>
          resolvePlan(target).pipe(
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
                    Effect.tap(() =>
                      destroyOptions.removeState === false ? Effect.void : forgetPlan(target.app),
                    ),
                    Effect.as(DESTROYED),
                  ),
            ),
          ),
        removeObservedService: (observed) =>
          removeObservedContainer(observed, { api: dockerApi, ctx: DOCKER_CTX }).pipe(
            Effect.map(observedRemoval),
          ),
        logs: (target, logOptions) =>
          Stream.unwrap(
            resolvePlan(target).pipe(
              Effect.map((plan) => {
                if (plan !== undefined) {
                  const service = plan.services[target.service];
                  const logFileAccess =
                    options.logFileAccess ??
                    (service === undefined || logFileHelperPayload === undefined
                      ? undefined
                      : makeDockerLogFileAccess({
                          providerId: PROVIDER_ID,
                          api: dockerApi,
                          container: containerName(plan, service),
                          helperPayload: logFileHelperPayload,
                        }));
                  return logs(plan, target, logOptions, {
                    api: dockerApi,
                    ctx: DOCKER_CTX,
                    ...(logFileAccess === undefined ? {} : { logFileAccess }),
                  });
                }

                return Stream.fromEffect(
                  discoverContainers(dockerApi, APP_LABEL).pipe(
                    Effect.flatMap((containers) => {
                      const container = containers.find(
                        (c) =>
                          c.labels[APP_LABEL] === target.app && c.labels[SERVICE_LABEL] === target.service,
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
                    logsWithoutPlan(container.name, target.service, target, logOptions, { api: dockerApi }),
                  ),
                );
              }),
            ),
          ),
        list: (filter) =>
          discoverContainers(dockerApi, APP_LABEL).pipe(
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

                    let endpoints: ServiceRuntimeInfo["endpoints"] = [];
                    if (inspectResponse.status >= 200 && inspectResponse.status < 300) {
                      endpoints = publishedEndpointsFromInspect(yield* parseJson(inspectResponse, "list"));
                    }

                    return {
                      app: AppId.make(appId),
                      ...(container.labels[APP_ROOT_LABEL] === undefined
                        ? {}
                        : { appRoot: AbsolutePath.make(container.labels[APP_ROOT_LABEL]) }),
                      service: ServiceName.make(serviceName),
                      providerId: ProviderId.make(PROVIDER_ID),
                      status,
                      state: status,
                      containerId: container.id,
                      labels: container.labels,
                      endpoints,
                      ...(container.startedAt === undefined
                        ? {}
                        : { lastStartedAt: new Date(container.startedAt) }),
                    };
                  }),
              ),
            ),
          ),
      }),
    ),
  );
};

export const makeProviderLayer = (options: ProviderLayerOptions = {}) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

export const provider = makeProviderLayer();

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
        appliedPlans: (ctx) =>
          Effect.flatMap(PathsService, (paths) =>
            listAppliedPlans(ctx.stateStore, paths.pluginStateDir(PLUGIN_NAME)),
          ),
        make: (ctx) =>
          Effect.gen(function* () {
            const paths = yield* PathsService;
            const assets = yield* LogFileHelperAssets;
            const appPlanSanitizer = yield* AppPlanSanitizer;
            const eventService = yield* Effect.serviceOption(EventService);
            const logFileHelperPayloads = yield* assets.payloads;
            return yield* makeRuntimeProvider({
              platform: paths.platform,
              ...(eventService._tag === "None" ? {} : { eventService: eventService.value }),
              logFileHelperPayloads,
              appliedPlanState: ctx.stateStore,
              appliedPlanStateDir: paths.pluginStateDir(PLUGIN_NAME),
              sanitizeAppliedPlan: appPlanSanitizer.sanitizeForPersistence,
            });
          }),
      },
    ],
  ]),
  doctorChecks: [makeIptablesForwardCheck()],
});
