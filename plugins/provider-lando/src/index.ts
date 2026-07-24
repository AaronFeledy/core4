/**
 * `@lando/provider-lando` — Lando-managed RuntimeProvider.
 */
import { Effect, Layer, Schema, Stream } from "effect";

import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { makeDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import {
  type LogFileHelperPayloads,
  logFileHelperPayloadForTargets,
} from "@lando/container-runtime/log-file-helper-payloads";
import { stripHostProxyRunLando } from "@lando/core/host-proxy-transport";
import { managedRuntimePodmanArgv0 } from "@lando/core/managed-runtime-service";
import { ProviderUnavailableError, type StateStoreError } from "@lando/sdk/errors";
import type { LogFileAccess } from "@lando/sdk/log-follow";
import type { RetryPolicy } from "@lando/sdk/probe";
import {
  type AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderId,
  type ProviderSetupPlan,
} from "@lando/sdk/schema";
import { type AppSelector, RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";

import { loadAppliedPlan, persistAppliedPlan, removeAppliedPlan } from "./applied-state.ts";
import { bringDown } from "./bring-down.ts";
import { type BringUpOptions, bringUp } from "./bring-up.ts";
import {
  type PodmanApiClient,
  introspectProviderCapabilities,
  makePodmanApiClient,
  mvpProviderCapabilities,
} from "./capabilities.ts";
import { getContainerDiedEvents } from "./container-events.ts";
import { ensureRuntime } from "./ensure-runtime.ts";
import { exec, execStream } from "./exec.ts";
import { pullImage } from "./image-pull.ts";
import { inspect } from "./inspect.ts";
import type { RuntimeGenerationStore } from "./linux-runtime-generation.ts";
import { logs } from "./logs.ts";
import {
  type PodmanServiceRunner,
  buildPodmanServiceArgs,
  makeSystemPodmanServiceRunner,
} from "./podman-service-runner.ts";
import { redactDetails } from "./redact.ts";
import {
  type RootlessProbes,
  classifyRootlessFailure,
  makeSystemRootlessProbes,
} from "./rootless-preflight.ts";
import { type ArtifactDownload, makeDefaultRuntimeBundleDownloader } from "./runtime-bundle.ts";
import {
  type RuntimeServiceStatus,
  probeRuntimeServiceStatus,
  teardownRuntimeService as teardownManagedRuntimeService,
} from "./runtime-status.ts";
import {
  type PodmanCommandRunner,
  type PodmanMachineRunner,
  type RuntimeBundleDownloader,
  type RuntimeSetupProgress,
  makeSystemPodmanMachineRunner,
  setupProviderLando,
} from "./setup.ts";
import {
  type LinuxHostRelease,
  applyApprovedProviderSetupPlan,
  inspectUidmapSetupPlan,
  readLinuxHostRelease,
} from "./uidmap-provision.ts";

export {
  appliedPlanPath,
  appliedPlansDir,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "./applied-state.ts";
export { composePath, emitCompose, renderCompose } from "./compose.ts";
export { withApiReason } from "./redact.ts";
export { getContainerDiedEvents, parseContainerEventPayloads } from "./container-events.ts";
export type { ContainerDiedEventsOptions } from "./container-events.ts";
export {
  buildImagePullRequest,
  parseImagePullFrame,
  pullImage,
} from "./image-pull.ts";
export type { ImagePullFrame, PullImageDeps } from "./image-pull.ts";
export {
  IMPORT_NATIVE_CA_FLAG,
  buildManagedMachineInitArgs,
  buildManagedMachineTrustSyncArgs,
  resolveMachineTrustImport,
  windowsHyperVPrepRemediation,
} from "./machine-trust.ts";
export type {
  MachineTrustDecision,
  MachineTrustInput,
  RecordedMachineOwnership,
} from "./machine-trust.ts";
export {
  buildLandoVolumeFilters,
  buildVolumePruneRequest,
  parseVolumePruneResult,
  pruneVolumes,
  volumeMatchesFilters,
} from "./volume-prune.ts";
export type {
  LandoVolumeFilterOptions,
  PrunedVolume,
  VolumeFilterMap,
  VolumePruneError,
  VolumePruneOptions,
  VolumePruneParse,
  VolumePruneReport,
} from "./volume-prune.ts";
export type { EmitComposeOptions, EmitComposeResult } from "./compose.ts";
export { bringUp } from "./bring-up.ts";
export type { BringUpOptions } from "./bring-up.ts";
export { bringDown } from "./bring-down.ts";
export type { BringDownOptions } from "./bring-down.ts";
export { ensureRuntime } from "./ensure-runtime.ts";
export type { EnsureRuntimeDeps } from "./ensure-runtime.ts";
export { exec, execStream } from "./exec.ts";
export type { ExecOptions } from "./exec.ts";
export { waitForServiceHealth } from "./health.ts";
export type { WaitForServiceHealthOptions } from "./health.ts";
export { inspect } from "./inspect.ts";
export type { InspectOptions } from "./inspect.ts";
export { logs } from "./logs.ts";
export type { LogsOptions } from "./logs.ts";
export {
  RuntimeLaunchError,
  buildPodmanServiceArgs,
  makeSystemPodmanServiceRunner,
} from "./podman-service-runner.ts";
export type { PodmanServiceRunner, PodmanServiceSpec } from "./podman-service-runner.ts";
export {
  RootlessPrerequisiteError,
  classifyRootlessFailure,
  makeSystemRootlessProbes,
} from "./rootless-preflight.ts";
export {
  applyApprovedProviderSetupPlan,
  inspectUidmapSetupPlan,
  parseLinuxHostRelease,
  readLinuxHostRelease,
} from "./uidmap-provision.ts";
export type { LinuxHostRelease } from "./uidmap-provision.ts";
export type {
  RootlessPrerequisite,
  RootlessProbeResults,
  RootlessProbes,
} from "./rootless-preflight.ts";
export {
  IntelMacUnsupportedError,
  MINIMUM_PODMAN_VERSION,
  PodmanMachinePrerequisiteError,
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  PodmanVersionUnsupportedError,
  WindowsMachineOsUnsupportedError,
  WindowsMachinePrerequisiteError,
  ensureMacOSPodmanMachine,
  isIntelMacHost,
  ensureWindowsPodmanMachine,
  makeSystemPodmanMachineRunner,
  makeSystemPodmanCommandRunner,
  providerStatePath,
  setupProviderLando,
  stopMacOSPodmanMachine,
  stopWindowsPodmanMachine,
  teardownMacOSPodmanMachine,
  teardownWindowsPodmanMachine,
  upgradeMacOSPodmanMachine,
  upgradeWindowsPodmanMachine,
} from "./setup.ts";
export type {
  PodmanCommandRunner,
  PodmanMachineRunner,
  PodmanMachineStatus,
  PodmanVersionSource,
  RuntimeBundle,
  RuntimeBundleDownloader,
  RuntimeSetupPhase,
  RuntimeSetupProgress,
  SetupOptions,
  SetupResult,
} from "./setup.ts";
export { parsePodmanVersionNumbers, podmanVersionMeetsFloor } from "./version-floor.ts";
export type { PodmanVersionNumbers } from "./version-floor.ts";

export {
  ProviderBundleChecksumError,
  RUNTIME_BUNDLE_MANIFEST,
  RUNTIME_BUNDLE_MANIFEST_ENV,
  makeDefaultRuntimeBundleDownloader,
  makeRuntimeBundleDownloader,
  resolveRuntimeBundleEntry,
  runtimeBundleCachePath,
} from "./runtime-bundle.ts";
export type {
  ArtifactDownload,
  ArtifactDownloadRequest,
  ArtifactDownloadResult,
  DefaultRuntimeBundleDownloaderOptions,
  OverrideRuntimeBundleManifest,
  RuntimeBundleDownloaderOptions,
  RuntimeBundleEntry,
  RuntimeBundleManifest,
} from "./runtime-bundle.ts";

export { probeRuntimeServiceStatus, teardownRuntimeService } from "./runtime-status.ts";
export type { RuntimeServiceStatus, RuntimeStatusDeps } from "./runtime-status.ts";

export {
  decodeProviderCapabilities,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  macosMvpCapabilities,
  makePodmanApiClient,
  makePodmanInfoRequest,
  makePodmanPingRequest,
  mvpProviderCapabilities,
  providerLandoCapabilitiesForPlatform,
} from "./capabilities.ts";
export type {
  PodmanApiClient,
  PodmanApiRequest,
  PodmanHttpRequest,
  PodmanHttpResponse,
} from "./capabilities.ts";

export const PLUGIN_NAME = "@lando/provider-lando" as const;
const WINDOWS_MANAGED_MACHINE_PIPE = "\\\\.\\pipe\\podman-lando";

const makeUnavailable = (operation: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message: `provider-lando does not implement ${operation} yet.`,
  });

const makeNoPlanError = (appId: AppId, operation: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message: `No applied plan found for app "${appId}". The provider does implement ${operation}, but the app must be started first.`,
    remediation:
      "Run `lando start` (or `lando app:start`) to start the app, then retry. Alternatively, pass an AppPlan directly via `target.plan`.",
  });

const currentHostPlatform = (): HostPlatform | undefined => {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") {
    return process.platform;
  }
  return undefined;
};

const unsupportedHostPlatformError = () =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message: `provider-lando does not support host platform ${process.platform}.`,
    remediation: "Run `lando setup` on Linux, macOS, or Windows, or select another runtime provider.",
  });

const probeRuntimeSocketStatus = (podmanApi?: PodmanApiClient): Effect.Effect<RuntimeServiceStatus> => {
  if (podmanApi === undefined) {
    return Effect.succeed({ running: false, socketReachable: false, ownedServiceProcess: false });
  }

  return podmanApi.info.pipe(
    Effect.as({ running: true, socketReachable: true, ownedServiceProcess: false }),
    Effect.catchAllCause(() =>
      Effect.succeed({ running: false, socketReachable: false, ownedServiceProcess: false }),
    ),
  );
};

const runtimeStatusMessage = (status: RuntimeServiceStatus): string => {
  if (!status.socketReachable) return "runtime socket unreachable";

  const pidSummary =
    status.pid === undefined
      ? "no owned pid"
      : `pid ${status.pid} ${status.ownedServiceProcess ? "owned" : "not owned"}`;
  const orphanSummary =
    status.orphanPids === undefined || status.orphanPids.length === 0
      ? ""
      : `; orphan pids ${status.orphanPids.join(",")}`;
  return `runtime socket reachable; ${pidSummary}${orphanSummary}`;
};

export interface ProviderLayerOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly podmanCommand?: PodmanCommandRunner;
  readonly podmanMachine?: PodmanMachineRunner;
  readonly platform?: HostPlatform;
  readonly arch?: string;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly artifactDownload?: ArtifactDownload;
  readonly stateDir?: string;
  readonly runtimeBinDir?: string;
  readonly runtimeRunDir?: string;
  readonly runtimeStorageDir?: string;
  readonly runtimeConfigDir?: string;
  readonly socketPath?: string;
  readonly providerSocketPath?: string;
  readonly providerPidPath?: string;
  readonly podmanApiFactory?: (socketPath: string) => PodmanApiClient;
  readonly podmanService?: PodmanServiceRunner;
  readonly rootlessProbes?: RootlessProbes;
  readonly linuxHostRelease?: LinuxHostRelease;
  readonly readinessPolicy?: RetryPolicy;
  readonly eventService?: BringUpOptions["eventService"];
  readonly logFileAccess?: LogFileAccess;
  readonly logFileHelperPayloads?: LogFileHelperPayloads;
  readonly runtimeLock?: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | StateStoreError>;
  readonly runtimeGenerationStore?: RuntimeGenerationStore;
}

interface RuntimeProviderServiceControls {
  readonly getRuntimeServiceStatus: Effect.Effect<RuntimeServiceStatus>;
  readonly teardownRuntimeService: Effect.Effect<{ readonly terminated: boolean; readonly pid?: number }>;
}

type RuntimeProviderWithServiceControls = RuntimeProviderShape & RuntimeProviderServiceControls;
type RuntimeProviderWithContainerEvents = RuntimeProviderWithServiceControls & {
  readonly getContainerDiedEvents: ReturnType<typeof getContainerDiedEvents>;
};

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
  const plans = new Map<string, AppPlan>();
  const providerId = ProviderId.make("lando");
  const platform = options.platform ?? currentHostPlatform();
  if (platform === undefined) {
    return Effect.fail(unsupportedHostPlatformError());
  }
  const externalSocketPath = options.socketPath;
  const managedSocketPath =
    options.providerSocketPath === undefined
      ? undefined
      : platform === "win32"
        ? WINDOWS_MANAGED_MACHINE_PIPE
        : options.providerSocketPath;
  const socketPath = externalSocketPath ?? managedSocketPath;
  const podmanApi =
    options.podmanApi ??
    (socketPath === undefined ? undefined : (options.podmanApiFactory ?? makePodmanApiClient)(socketPath));
  const stateDir = options.stateDir;
  const runtimeBinDir = options.runtimeBinDir;
  const shouldManageRuntime = externalSocketPath === undefined && managedSocketPath !== undefined;
  const ensureSocketPath = shouldManageRuntime ? managedSocketPath : undefined;
  const arch = options.arch ?? (options.platform === undefined ? process.arch : undefined);
  const podmanBin =
    runtimeBinDir === undefined ? "podman" : managedRuntimePodmanArgv0(runtimeBinDir, platform);
  const serviceRunner = options.podmanService ?? makeSystemPodmanServiceRunner();
  const skipSetupSocketProbe =
    externalSocketPath === undefined && managedSocketPath !== undefined && options.podmanApi === undefined;
  let runtimeVersion: string | undefined;
  let bundleVersion: string | undefined;
  const machineRunner =
    options.podmanMachine ??
    (platform === "linux" || runtimeBinDir === undefined
      ? undefined
      : makeSystemPodmanMachineRunner(managedRuntimePodmanArgv0(runtimeBinDir, platform), "lando", platform));
  const artifactDownloadMissing = (): ProviderUnavailableError =>
    new ProviderUnavailableError({
      providerId: "lando",
      operation: "setup",
      message: "provider-lando runtime-bundle setup requires an injected artifactDownload function.",
      remediation:
        "Construct the provider through the core runtime provider registry so the shared artifact downloader can be injected.",
    });
  const missingArtifactDownload: ArtifactDownload = () => Effect.fail(artifactDownloadMissing());
  const makeSetupRuntimeBundleDownloader = (
    url?: string,
    sha256?: string,
  ): RuntimeBundleDownloader | undefined =>
    stateDir === undefined
      ? undefined
      : makeDefaultRuntimeBundleDownloader({
          stateDir,
          platform,
          ...(url === undefined ? {} : { env: {} }),
          ...(url === undefined ? {} : { url }),
          ...(sha256 === undefined ? {} : { sha256 }),
          artifactDownload: options.artifactDownload ?? missingArtifactDownload,
        });
  const canEnsure =
    podmanApi !== undefined &&
    shouldManageRuntime &&
    ensureSocketPath !== undefined &&
    options.runtimeStorageDir !== undefined &&
    options.runtimeRunDir !== undefined &&
    options.runtimeConfigDir !== undefined &&
    options.providerPidPath !== undefined;
  const rootlessProbes = options.rootlessProbes ?? makeSystemRootlessProbes();
  const ensureGuard = Effect.unsafeMakeSemaphore(1);
  const withLaunchLock = <A, E>(body: Effect.Effect<A, E>) =>
    ensureGuard.withPermits(1)(options.runtimeLock?.(body) ?? body);
  const ensureEffectFor = (
    progress?: RuntimeSetupProgress,
    runtimeBundleVersion?: string,
  ): Effect.Effect<void, ProviderUnavailableError> =>
    canEnsure
      ? ensureRuntime({
          platform,
          podmanApi,
          serviceRunner,
          ...(machineRunner === undefined ? {} : { machineRunner }),
          podmanBin,
          storageDir: options.runtimeStorageDir,
          runRoot: options.runtimeRunDir,
          configDir: options.runtimeConfigDir,
          socketPath: ensureSocketPath,
          pidPath: options.providerPidPath,
          ...(runtimeBundleVersion === undefined ? {} : { runtimeBundleVersion }),
          rootlessProbes,
          withLaunchLock,
          ...(options.runtimeGenerationStore === undefined
            ? {}
            : { generationStore: options.runtimeGenerationStore }),
          ...(options.readinessPolicy === undefined ? {} : { readinessPolicy: options.readinessPolicy }),
          ...(progress === undefined
            ? {}
            : {
                setupProgress: {
                  launch: (body) => progress.run("launch", body),
                  readiness: (body) => progress.run("readiness", body),
                },
              }),
        })
      : Effect.void;
  const ensureEffect = ensureEffectFor();
  const ensureBefore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    ensureEffect.pipe(Effect.zipRight(effect));
  const ensureBeforeStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    Stream.unwrap(ensureEffect.pipe(Effect.as(stream)));
  const dataPlane =
    podmanApi === undefined
      ? undefined
      : makeProviderDataPlane({
          providerId: "lando",
          api: podmanApi,
          snapshotMode: "native",
          redactDetails,
        });

  const resolvePlan = (target: AppSelector): Effect.Effect<AppPlan | undefined, never> => {
    if (target.plan !== undefined) return Effect.succeed(target.plan);
    const cached = plans.get(target.app);
    if (cached !== undefined) return Effect.succeed(cached);
    if (stateDir === undefined) return Effect.succeed(undefined);
    return loadAppliedPlan(stateDir, target.app).pipe(
      Effect.tap((loaded) =>
        Effect.sync(() => {
          if (loaded !== undefined) plans.set(target.app, loaded);
        }),
      ),
    );
  };

  const rememberPlan = (plan: AppPlan): Effect.Effect<void, ProviderUnavailableError> => {
    const persistedPlan = stripHostProxyRunLando(plan);
    plans.set(plan.id, persistedPlan);
    return stateDir === undefined
      ? Effect.void
      : persistAppliedPlan(stateDir, persistedPlan).pipe(Effect.asVoid);
  };

  const forgetPlan = (appId: AppId): Effect.Effect<void> => {
    plans.delete(appId);
    return stateDir === undefined ? Effect.void : removeAppliedPlan(stateDir, appId);
  };

  return Effect.gen(function* () {
    const shouldProbeCapabilities = options.podmanApi !== undefined || externalSocketPath !== undefined;
    const capabilities =
      shouldProbeCapabilities && podmanApi !== undefined
        ? introspectProviderCapabilities(podmanApi, platform)
        : Effect.succeed(mvpProviderCapabilities(platform, arch));
    const { capabilities: resolvedCapabilities, logFileHelperPayload } = yield* capabilities.pipe(
      Effect.map((resolved) => ({
        capabilities: {
          ...resolved,
          artifactBuild: podmanApi !== undefined && resolved.artifactBuild,
          artifactPull: podmanApi !== undefined && resolved.artifactPull,
          serviceLogSources:
            options.logFileAccess !== undefined ||
            logFileHelperPayloadForTargets(
              options.logFileHelperPayloads,
              resolved.hostProxy?.containerTargets,
            ) !== undefined,
        },
        logFileHelperPayload: logFileHelperPayloadForTargets(
          options.logFileHelperPayloads,
          resolved.hostProxy?.containerTargets,
        ),
      })),
    );
    const managedRuntimeStatusDeps =
      shouldManageRuntime &&
      managedSocketPath !== undefined &&
      options.runtimeStorageDir !== undefined &&
      options.runtimeRunDir !== undefined &&
      options.runtimeConfigDir !== undefined &&
      options.providerPidPath !== undefined
        ? {
            ...(podmanApi === undefined ? {} : { podmanApi }),
            serviceRunner,
            spec: buildPodmanServiceArgs({
              podmanBin,
              storageDir: options.runtimeStorageDir,
              runRoot: options.runtimeRunDir,
              configDir: options.runtimeConfigDir,
              socketPath: managedSocketPath,
            }),
            pidPath: options.providerPidPath,
          }
        : undefined;
    const runtimeServiceStatus =
      managedRuntimeStatusDeps === undefined
        ? probeRuntimeSocketStatus(podmanApi)
        : probeRuntimeServiceStatus(managedRuntimeStatusDeps);
    const managedRuntimeServicePaths =
      shouldManageRuntime &&
      runtimeBinDir !== undefined &&
      managedSocketPath !== undefined &&
      options.runtimeStorageDir !== undefined &&
      options.runtimeRunDir !== undefined &&
      options.runtimeConfigDir !== undefined &&
      options.providerPidPath !== undefined
        ? {
            platform,
            runtimeBinDir,
            runtimeStorageDir: options.runtimeStorageDir,
            runtimeRunDir: options.runtimeRunDir,
            runtimeConfigDir: options.runtimeConfigDir,
            providerSocketPath: managedSocketPath,
            providerPidPath: options.providerPidPath,
          }
        : undefined;

    const provider: RuntimeProviderWithContainerEvents = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform,
      capabilities: resolvedCapabilities,
      isAvailable: Effect.succeed(true),
      planSetup: () =>
        shouldManageRuntime && platform === "linux"
          ? inspectUidmapSetupPlan({
              platform,
              host: options.linuxHostRelease ?? readLinuxHostRelease(),
              probes: rootlessProbes,
            })
          : Effect.succeed({ providerId, changes: [] }),
      setup: (plan: ProviderSetupPlan, setupOptions) =>
        Effect.gen(function* () {
          const result = yield* setupProviderLando({
            ...(podmanApi === undefined ? {} : { podmanApi }),
            ...(options.podmanCommand === undefined ? {} : { podmanCommand: options.podmanCommand }),
            ...(options.podmanMachine === undefined ? {} : { podmanMachine: options.podmanMachine }),
            ...(options.artifactDownload === undefined ? {} : { artifactDownload: options.artifactDownload }),
            platform,
            ...(arch === undefined ? {} : { arch }),
            ...(() => {
              const setupRuntimeBundleDownloader =
                setupOptions.runtimeBundleUrl === undefined
                  ? (options.runtimeBundleDownloader ??
                    makeSetupRuntimeBundleDownloader(undefined, undefined))
                  : makeSetupRuntimeBundleDownloader(
                      setupOptions.runtimeBundleUrl,
                      setupOptions.runtimeBundleSha256,
                    );
              return setupRuntimeBundleDownloader === undefined
                ? {}
                : { runtimeBundleDownloader: setupRuntimeBundleDownloader };
            })(),
            ...(stateDir === undefined ? {} : { stateDir }),
            ...(runtimeBinDir === undefined ? {} : { runtimeBinDir }),
            ...(options.runtimeConfigDir === undefined ? {} : { runtimeConfigDir: options.runtimeConfigDir }),
            ...(socketPath === undefined ? {} : { socketPath }),
            ...(skipSetupSocketProbe ? { skipSocketProbe: true } : {}),
            ...(canEnsure
              ? {
                  managedRuntimeSetup: (progress: RuntimeSetupProgress) =>
                    Effect.gen(function* () {
                      yield* progress.run(
                        "prerequisites",
                        applyApprovedProviderSetupPlan(plan, {
                          probes: rootlessProbes,
                          privilege: setupOptions.privilege,
                        }).pipe(
                          Effect.andThen(
                            Effect.suspend(() => {
                              const failure = classifyRootlessFailure(rootlessProbes.probe());
                              return failure === undefined ? Effect.void : Effect.fail(failure);
                            }),
                          ),
                        ),
                      );
                      yield* ensureEffectFor(progress, progress.runtimeBundleVersion);
                    }),
                }
              : { readinessCheck: ensureEffect }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
          });
          runtimeVersion = result.podmanVersion;
          bundleVersion = result.runtimeBundleVersion;
        }),
      getStatus:
        podmanApi === undefined
          ? Effect.succeed({ running: false, message: "Lando runtime service is not configured." })
          : runtimeServiceStatus.pipe(
              Effect.map((status) => ({
                running: status.running,
                message: runtimeStatusMessage(status),
              })),
            ),
      getRuntimeServiceStatus: runtimeServiceStatus,
      getContainerDiedEvents:
        podmanApi === undefined ? Effect.succeed([]) : getContainerDiedEvents(podmanApi),
      teardownRuntimeService:
        managedRuntimeServicePaths === undefined
          ? Effect.succeed({ terminated: false })
          : teardownManagedRuntimeService({ paths: managedRuntimeServicePaths }),
      getVersions: Effect.sync(() => ({
        provider: "0.0.0",
        ...(runtimeVersion === undefined ? {} : { runtime: runtimeVersion }),
        ...(bundleVersion === undefined ? {} : { bundle: bundleVersion }),
      })),
      buildArtifact:
        podmanApi === undefined
          ? () => Effect.fail(makeUnavailable("buildArtifact"))
          : (spec) => ensureBefore(buildContainerArtifact(spec, { providerId: "lando", api: podmanApi })),
      pullArtifact:
        podmanApi === undefined
          ? () => Effect.fail(makeUnavailable("pullArtifact"))
          : (spec) =>
              ensureBefore(
                pullImage(podmanApi, spec.ref, {
                  providerId: "lando",
                  publish: (event) =>
                    options.eventService?.publish(event).pipe(Effect.catchAll(() => Effect.void)) ??
                    Effect.void,
                }).pipe(Effect.as({ providerId, ref: spec.ref })),
              ),
      removeArtifact: () => Effect.void,
      apply: (plan, applyOptions) =>
        Effect.gen(function* () {
          yield* ensureEffect;
          const result = yield* bringUp(plan, {
            ...(podmanApi === undefined ? {} : { podmanApi }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
            ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
          });
          yield* rememberPlan(plan);
          return result;
        }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: (target, destroyOptions) =>
        Effect.gen(function* () {
          const plan = yield* resolvePlan(target);
          if (plan === undefined) return;
          yield* ensureEffect;
          yield* bringDown(plan, {
            ...(podmanApi === undefined ? {} : { podmanApi }),
            volumes: destroyOptions.volumes,
            ...(destroyOptions.purgeCaches === undefined ? {} : { purgeCaches: destroyOptions.purgeCaches }),
          });
          if (destroyOptions.removeState !== false) {
            yield* forgetPlan(target.app);
          }
        }),
      exec: (target, command) =>
        Effect.gen(function* () {
          yield* ensureEffect;
          const plan = yield* resolvePlan(target);
          if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "exec"));
          return yield* exec(plan, target, command, {
            ...(podmanApi === undefined ? {} : { podmanApi }),
          });
        }),
      execStream: (target, command) =>
        Stream.unwrap(
          ensureEffect.pipe(
            Effect.zipRight(
              resolvePlan(target).pipe(
                Effect.map((plan) =>
                  plan === undefined
                    ? Stream.fail(makeNoPlanError(target.app, "execStream"))
                    : execStream(plan, target, command, {
                        ...(podmanApi === undefined ? {} : { podmanApi }),
                      }),
                ),
              ),
            ),
          ),
        ),
      run:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("run"))
          : (spec) => ensureBefore(dataPlane.run(spec)),
      runStream:
        dataPlane === undefined
          ? () => Stream.fail(makeUnavailable("runStream"))
          : (spec) => ensureBeforeStream(dataPlane.runStream(spec)),
      logs: (target, logOptions) =>
        Stream.unwrap(
          resolvePlan(target).pipe(
            Effect.flatMap((plan) =>
              plan === undefined
                ? Effect.succeed(Stream.fail(makeNoPlanError(target.app, "logs")))
                : ensureEffect.pipe(
                    Effect.as(
                      logs(plan, target, logOptions, {
                        ...(podmanApi === undefined ? {} : { podmanApi }),
                        ...(() => {
                          const logFileAccess =
                            options.logFileAccess ??
                            (podmanApi === undefined || logFileHelperPayload === undefined
                              ? undefined
                              : makeDockerLogFileAccess({
                                  providerId: "lando",
                                  api: podmanApi,
                                  container: `lando-${plan.slug}-${target.service}`.replace(
                                    /[^a-zA-Z0-9_.-]/gu,
                                    "-",
                                  ),
                                  helperPayload: logFileHelperPayload,
                                }));
                          return logFileAccess === undefined ? {} : { logFileAccess };
                        })(),
                      }),
                    ),
                  ),
            ),
          ),
        ),
      inspect: (target) =>
        Effect.gen(function* () {
          const plan = yield* resolvePlan(target);
          if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "inspect"));
          yield* ensureEffect;
          return yield* inspect(plan, target, {
            ...(podmanApi === undefined ? {} : { podmanApi }),
          });
        }),
      list: (filter) =>
        ensureEffect.pipe(
          Effect.zipRight(
            Effect.forEach(Array.from(plans.values()), (plan) =>
              Effect.forEach(Object.values(plan.services), (service) =>
                inspect(
                  plan,
                  { app: plan.id, service: service.name },
                  { ...(podmanApi === undefined ? {} : { podmanApi }) },
                ),
              ),
            ),
          ),
          Effect.map((snapshots) => snapshots.flat()),
          Effect.map((snapshots) =>
            filter.app === undefined
              ? snapshots
              : snapshots.filter((snapshot) => snapshot.app === filter.app),
          ),
        ),
      snapshotVolume:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("snapshotVolume"))
          : (spec) => ensureBefore(dataPlane.snapshotVolume(spec)),
      restoreVolume:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("restoreVolume"))
          : (spec) => ensureBefore(dataPlane.restoreVolume(spec)),
      listVolumes:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("listVolumes"))
          : (filter) => ensureBefore(dataPlane.listVolumes(filter)),
      removeVolume:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("removeVolume"))
          : (ref) => ensureBefore(dataPlane.removeVolume(ref)),
      copyToService:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("copyToService"))
          : (target, spec) =>
              ensureBefore(
                resolvePlan(target).pipe(
                  Effect.flatMap((plan) =>
                    dataPlane.copyToService(plan === undefined ? target : { ...target, plan }, spec),
                  ),
                ),
              ),
      copyFromService:
        dataPlane === undefined
          ? () => Stream.fail(makeUnavailable("copyFromService"))
          : (target, spec) =>
              ensureBeforeStream(
                Stream.unwrap(
                  resolvePlan(target).pipe(
                    Effect.map((plan) =>
                      dataPlane.copyFromService(plan === undefined ? target : { ...target, plan }, spec),
                    ),
                  ),
                ),
              ),
      exportArtifact:
        dataPlane === undefined
          ? () => Stream.fail(makeUnavailable("exportArtifact"))
          : (ref) => ensureBeforeStream(dataPlane.exportArtifact(ref)),
      importArtifact:
        dataPlane === undefined
          ? () => Effect.fail(makeUnavailable("importArtifact"))
          : (data) => ensureBefore(dataPlane.importArtifact(data)),
    };

    return provider satisfies RuntimeProviderShape;
  });
};

export const makeProviderLayer = (options: ProviderLayerOptions = {}) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

export const provider = makeProviderLayer();

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Reference Lando-managed RuntimeProvider implementation.",
  enabled: true,
  contributes: {
    providers: ["lando"],
    setup: {
      flags: [
        {
          name: "runtime-bundle-url",
          description: "Override the Lando-managed runtime bundle URL for setup.",
          type: "option",
        },
        {
          name: "runtime-bundle-sha256",
          description: "Pinned SHA-256 paired with --runtime-bundle-url for verifying a local bundle.",
          type: "option",
        },
      ],
    },
  },
  entry: "./src/index.ts",
});
