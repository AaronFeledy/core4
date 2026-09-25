import { type Context, Effect, Layer, Schema, Stream } from "effect";

import { VOLUME_WITNESS_IMAGE, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { libpodPullDialect, libpodWaitDialect } from "@lando/container-runtime/dialect";
import type {
  EngineHttpRequest,
  EngineHttpResponse,
  PodmanApiClient,
} from "@lando/container-runtime/engine-api";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import {
  type PullImageOptions,
  buildImagePullRequest,
  parseImagePullFrame,
  pullImage as runtimePullImage,
} from "@lando/container-runtime/image-pull";
import { makeDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import {
  type LogFileHelperPayloads,
  logFileHelperPayloadForTargets,
} from "@lando/container-runtime/log-file-helper-payloads";
import { mergeAppliedPlan } from "@lando/container-runtime/plan";
import { makePodmanApiClient as makeRuntimePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import {
  type BringDownOptions,
  bringDown as runtimeBringDown,
} from "@lando/container-runtime/podman/bring-down";
import {
  type BringUpOptions,
  podmanVolumeCreationLabels,
  bringUp as runtimeBringUp,
  scratchLabelsForPlan,
} from "@lando/container-runtime/podman/bring-up";
import {
  type EmitComposeOptions,
  composePath as runtimeComposePath,
  emitCompose as runtimeEmitCompose,
  renderCompose as runtimeRenderCompose,
} from "@lando/container-runtime/podman/compose";
import { podmanComposeKnobs } from "@lando/container-runtime/podman/compose-knobs";
import {
  type ContainerDiedEventsOptions,
  parseContainerEventPayloads,
  getContainerDiedEvents as runtimeGetContainerDiedEvents,
} from "@lando/container-runtime/podman/container-events";
import {
  type ExecOptions,
  exec as runtimeExec,
  execStream as runtimeExecStream,
} from "@lando/container-runtime/podman/exec";
import {
  type WaitForServiceHealthOptions,
  waitForServiceHealth as runtimeWaitForServiceHealth,
} from "@lando/container-runtime/podman/health";
import { type InspectOptions, inspect as runtimeInspect } from "@lando/container-runtime/podman/inspect";
import { type LogsOptions, logs as runtimeLogs } from "@lando/container-runtime/podman/logs";
import {
  MINIMUM_PODMAN_VERSION,
  podmanVersionMeetsFloor,
} from "@lando/container-runtime/podman/version-floor";
import {
  type VolumePruneOptions,
  buildLandoVolumeFilters,
  buildVolumePruneRequest,
  parseVolumePruneResult,
  pruneVolumes as runtimePruneVolumes,
  volumeMatchesFilters,
} from "@lando/container-runtime/podman/volume-prune";
import { redactDetails, withApiReason } from "@lando/container-runtime/redact";
import { makeResolvedProviderOps } from "@lando/container-runtime/runtime-provider";
import {
  DESTROYED,
  DESTROY_NO_OP,
  type ServiceLifecycleOptions,
  observedRemoval,
  removeObservedContainer,
  postExactServiceLifecycle as runtimePostExactServiceLifecycle,
  postServiceLifecycle as runtimePostServiceLifecycle,
} from "@lando/container-runtime/service-lifecycle";
import {
  type WaitForExitOptions,
  waitForExit as runtimeWaitForExit,
} from "@lando/container-runtime/wait-for-exit";
import { ProviderUnavailableError, ServiceExecError, type StateStoreError } from "@lando/sdk/errors";
import type { LogFileAccess } from "@lando/sdk/log-follow";
import { type PluginStateStore, definePlugin } from "@lando/sdk/plugins";
import type { RetryPolicy } from "@lando/sdk/probe";
import {
  type AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderId,
  type ProviderSetupPlan,
  hostPlatformFamily,
} from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  Downloader,
  EventService,
  LogFileHelperAssets,
  PathsService,
  ProcessRunner,
  type ProviderError,
  RuntimeProvider,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { inspectAppliedFileSync } from "./applied-file-sync.ts";
import {
  inspectAppliedPlan,
  listAppliedPlans,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "./applied-state.ts";
import { introspectProviderCapabilities, mvpProviderCapabilities } from "./capabilities.ts";
import { ensureRuntime } from "./ensure-runtime.ts";
import { makeWindowsHostProxyBridge } from "./host-proxy-bridge.ts";
import { rejectIntelMacHost } from "./host-support.ts";
import type { RuntimeGenerationStore } from "./linux-runtime-generation.ts";
import {
  buildManagedRuntimeServiceSpec,
  managedRuntimePodmanArgv0,
  terminateOwnedRuntimeService,
} from "./managed-runtime-service.ts";
import { makePluginArtifactDownload, makePluginRuntimeState } from "./plugin-runtime.ts";
import {
  type PodmanServiceRunner,
  buildPodmanServiceArgs,
  makeSystemPodmanServiceRunner,
} from "./podman-service-runner.ts";
import {
  type LinuxHostRelease,
  applyApprovedProviderSetupPlan,
  inspectUidmapSetupPlan,
  readLinuxHostRelease,
} from "./prerequisite-provision.ts";
import { LANDO_CTX } from "./provider-context.ts";
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
  MANAGED_MACHINE_NAME,
  type PodmanCommandRunner,
  type PodmanMachineRunner,
  type RuntimeBundleDownloader,
  type RuntimeSetupProgress,
  makeSystemPodmanMachineRunner,
  setupProviderLando,
} from "./setup.ts";
import { runSmokeReadinessProbe } from "./smoke-probe.ts";
import {
  isManagedNftMissingMessage,
  landoStartFailureRemediation,
  makeLandoStartFailureRemediation,
  startFailureRemediation,
} from "./start-remediation.ts";
import { hasHostSystemd } from "./user-systemd-session.ts";
import { windowsMachineNetworkPlan } from "./windows-machine-network.ts";
import {
  WINDOWS_COMPAT_NETWORK_LIST_PATH,
  makeWindowsPublishedRecovery,
  publishedFactsFromCompatResponses,
  supportsWindowsPublishedRecovery,
  withPublishedRecoveryAfterLifecycle,
} from "./windows-publish-recovery.ts";
import { windowsStdinExec, windowsStdinExecStream } from "./windows-stdin-exec.ts";
import { makeWslMountPropagationCheck } from "./wsl-mount-propagation.ts";

export {
  appliedPlanPath,
  appliedPlansDir,
  listAppliedPlans,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "./applied-state.ts";
export { buildImagePullRequest, parseContainerEventPayloads, parseImagePullFrame, withApiReason };
export type { PodmanApiClient } from "@lando/container-runtime/engine-api";
export type PodmanHttpRequest = EngineHttpRequest;
export type PodmanHttpResponse = EngineHttpResponse;
export type { ImagePullFrame, PullImageDeps, PulledImage } from "@lando/container-runtime/image-pull";
export type { ContainerDiedEventsOptions } from "@lando/container-runtime/podman/container-events";
export type { EmitComposeOptions, EmitComposeResult } from "@lando/container-runtime/podman/compose";
export type { BringDownOptions } from "@lando/container-runtime/podman/bring-down";
export type { BringUpOptions, StartFailureRemediation } from "@lando/container-runtime/podman/bring-up";
export type { ExecOptions } from "@lando/container-runtime/podman/exec";
export type { WaitForServiceHealthOptions } from "@lando/container-runtime/podman/health";
export type { InspectOptions } from "@lando/container-runtime/podman/inspect";
export type { LogsOptions } from "@lando/container-runtime/podman/logs";
export type {
  LandoVolumeFilterOptions,
  PrunedVolume,
  VolumeFilterMap,
  VolumePruneError,
  VolumePruneOptions,
  VolumePruneParse,
  VolumePruneReport,
} from "@lando/container-runtime/podman/volume-prune";
export type { PodmanVersionNumbers } from "@lando/container-runtime/podman/version-floor";
export type {
  ServiceLifecycleAction,
  ServiceLifecycleOptions,
} from "@lando/container-runtime/service-lifecycle";
export type { WaitForExitOptions } from "@lando/container-runtime/wait-for-exit";
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
  isManagedNftMissingMessage,
  parseVolumePruneResult,
  podmanComposeKnobs,
  scratchLabelsForPlan,
  startFailureRemediation,
  volumeMatchesFilters,
};
export { buildManagedRuntimeServiceArgs } from "./managed-runtime-service.ts";
export { ensureRuntime } from "./ensure-runtime.ts";
export type { EnsureRuntimeDeps } from "./ensure-runtime.ts";
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
} from "./prerequisite-provision.ts";
export type { LinuxHostRelease } from "./prerequisite-provision.ts";
export type {
  RootlessPrerequisite,
  RootlessProbeResults,
  RootlessProbes,
} from "./rootless-preflight.ts";
export {
  IntelMacUnsupportedError,
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
  MANAGED_MACHINE_NAME,
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
export { parsePodmanVersionNumbers } from "@lando/container-runtime/podman/version-floor";
export {
  makeWslMountPropagationCheck,
  parseRootMountPropagation,
} from "./wsl-mount-propagation.ts";
export type {
  RootMountPropagation,
  WslMountPropagationReaders,
} from "./wsl-mount-propagation.ts";
export {
  DEFAULT_BASE_IMAGE,
  ProviderLandoSmokeError,
  runBuildSmokeProbe,
  runContainerSmokeProbe,
  runHealthSmokeProbe,
  runSmokeReadinessProbe,
} from "./smoke-probe.ts";
export type { SmokeOperation, SmokeProbeDeps } from "./smoke-probe.ts";

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

export {
  NFT_MANIFEST,
  NFT_TOOL_VERSION,
  ensureManagedNft,
  hasUsableManagedNft,
  managedNftBinPath,
} from "./nft-provision.ts";
export type { EnsureManagedNftOptions, NftManifest } from "./nft-provision.ts";

export { probeRuntimeServiceStatus, teardownRuntimeService } from "./runtime-status.ts";
export type { RuntimeServiceStatus, RuntimeStatusDeps } from "./runtime-status.ts";

export {
  decodeProviderCapabilities,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  macosMvpCapabilities,
  mvpProviderCapabilities,
  providerLandoCapabilitiesForPlatform,
} from "./capabilities.ts";

export const makePodmanApiClient = (socketPath: string): PodmanApiClient =>
  makeRuntimePodmanApiClient(socketPath, LANDO_CTX);

export const bringUp = (plan: AppPlan, options: Omit<BringUpOptions, "ctx" | "startFailureRemediation">) =>
  runtimeBringUp(plan, { ...options, ctx: LANDO_CTX, startFailureRemediation: landoStartFailureRemediation });

export const bringDown = (
  plan: AppPlan,
  options: Omit<BringDownOptions, "ctx">,
): ReturnType<typeof runtimeBringDown> => runtimeBringDown(plan, { ...options, ctx: LANDO_CTX });

export const exec = (
  plan: AppPlan,
  target: Parameters<typeof runtimeExec>[1],
  command: Parameters<typeof runtimeExec>[2],
  options: Omit<ExecOptions, "ctx">,
) => runtimeExec(plan, target, command, { ...options, ctx: LANDO_CTX });

export const execStream = (
  plan: AppPlan,
  target: Parameters<typeof runtimeExecStream>[1],
  command: Parameters<typeof runtimeExecStream>[2],
  options: Omit<ExecOptions, "ctx">,
) => runtimeExecStream(plan, target, command, { ...options, ctx: LANDO_CTX });

export const inspect = (
  plan: AppPlan,
  target: Parameters<typeof runtimeInspect>[1],
  options: Omit<InspectOptions, "ctx">,
) => runtimeInspect(plan, target, { ...options, ctx: LANDO_CTX });

export const logs = (
  plan: AppPlan,
  target: Parameters<typeof runtimeLogs>[1],
  options: Parameters<typeof runtimeLogs>[2],
  runtime: Omit<LogsOptions, "ctx">,
) => runtimeLogs(plan, target, options, { ...runtime, ctx: LANDO_CTX });

export const waitForExit = (
  plan: AppPlan,
  target: Parameters<typeof runtimeWaitForExit>[1],
  options: Omit<WaitForExitOptions, "ctx" | "dialect">,
) => runtimeWaitForExit(plan, target, { ...options, ctx: LANDO_CTX, dialect: libpodWaitDialect });

export const postServiceLifecycle = (
  plan: AppPlan,
  target: Parameters<typeof runtimePostServiceLifecycle>[1],
  action: Parameters<typeof runtimePostServiceLifecycle>[2],
  options: Omit<ServiceLifecycleOptions, "ctx">,
) => runtimePostServiceLifecycle(plan, target, action, { ...options, ctx: LANDO_CTX });

export const pullImage = <E = never>(
  api: PodmanApiClient,
  reference: string,
  options: Omit<PullImageOptions<E>, "ctx" | "dialect"> = {},
) => runtimePullImage(api, reference, { ...options, ctx: LANDO_CTX, dialect: libpodPullDialect });

export const waitForServiceHealth = (
  plan: AppPlan,
  target: Parameters<typeof runtimeWaitForServiceHealth>[1],
  options: Omit<WaitForServiceHealthOptions, "ctx">,
) => runtimeWaitForServiceHealth(plan, target, { ...options, ctx: LANDO_CTX });

export const getContainerDiedEvents = (
  api: PodmanApiClient,
  options: Omit<ContainerDiedEventsOptions, "ctx"> = {},
) => runtimeGetContainerDiedEvents(api, { ...options, ctx: LANDO_CTX });

export const renderCompose = (plan: AppPlan): string => runtimeRenderCompose(plan, LANDO_CTX);

export const emitCompose = (plan: AppPlan, options: Omit<EmitComposeOptions, "ctx">) =>
  runtimeEmitCompose(plan, { ...options, ctx: LANDO_CTX });

export const composePath = (plan: AppPlan, options: Omit<EmitComposeOptions, "ctx">): string =>
  runtimeComposePath(plan, { ...options, ctx: LANDO_CTX });

export const pruneVolumes = (api: PodmanApiClient, options: Omit<VolumePruneOptions, "ctx">) =>
  runtimePruneVolumes(api, { ...options, ctx: LANDO_CTX });

export { MINIMUM_PODMAN_VERSION, podmanVersionMeetsFloor };

export const PLUGIN_NAME = "@lando/provider-lando" as const;
const WINDOWS_MANAGED_MACHINE_PIPE = "\\\\.\\pipe\\podman-lando";

const makeUnavailable = (operation: string) =>
  new ProviderUnavailableError({
    providerId: LANDO_CTX.providerId,
    operation,
    message: `provider-lando does not implement ${operation} yet.`,
  });

const makeNoPlanError = (appId: AppId, operation: string) =>
  new ProviderUnavailableError({
    providerId: LANDO_CTX.providerId,
    operation,
    message: `No applied plan found for app "${appId}". The provider does implement ${operation}, but the app must be started first.`,
    remediation:
      "Run `lando start` (or `lando app:start`) to start the app, then retry. Alternatively, pass an AppPlan directly via `target.plan`.",
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
  readonly processRunner?: Context.Tag.Service<typeof ProcessRunner>;
  readonly podmanCommand?: PodmanCommandRunner;
  readonly podmanMachine?: PodmanMachineRunner;
  readonly platform: HostPlatform;
  readonly arch?: string;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly artifactDownload?: ArtifactDownload;
  readonly nftCacheDir?: string;
  readonly stateDir?: string;
  readonly appliedPlanState?: PluginStateStore;
  readonly appliedPlanStateDir?: string;
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
  readonly smokeRetryPolicy?: RetryPolicy;
  readonly eventService?: BringUpOptions["eventService"];
  readonly logFileAccess?: LogFileAccess;
  readonly logFileHelperPayloads?: LogFileHelperPayloads;
  readonly runtimeLock?: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | StateStoreError>;
  readonly runtimeGenerationStore?: RuntimeGenerationStore;
  readonly sanitizeAppliedPlan: (plan: AppPlan) => AppPlan;
}

interface RuntimeProviderServiceControls {
  readonly getRuntimeServiceStatus: Effect.Effect<RuntimeServiceStatus>;
  readonly teardownRuntimeService: Effect.Effect<{ readonly terminated: boolean; readonly pid?: number }>;
}

type RuntimeProviderWithServiceControls = RuntimeProviderShape & RuntimeProviderServiceControls;
type RuntimeProviderWithContainerEvents = RuntimeProviderWithServiceControls & {
  readonly getContainerDiedEvents: ReturnType<typeof getContainerDiedEvents>;
};

export const makeRuntimeProvider = (options: ProviderLayerOptions) => {
  const plans = new Map<string, AppPlan>();
  const providerId = ProviderId.make("lando");
  const platform = options.platform;
  const family = hostPlatformFamily(platform);
  const externalSocketPath = options.socketPath;
  const managedSocketPath =
    options.providerSocketPath === undefined
      ? undefined
      : family === "win32"
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
  const arch = options.arch ?? process.arch;
  const podmanBin =
    runtimeBinDir === undefined ? "podman" : managedRuntimePodmanArgv0(runtimeBinDir, platform);
  const serviceRunner = options.podmanService ?? makeSystemPodmanServiceRunner();
  const skipSetupSocketProbe =
    externalSocketPath === undefined && managedSocketPath !== undefined && options.podmanApi === undefined;
  let runtimeVersion: string | undefined;
  let bundleVersion: string | undefined;
  const machineRunner =
    options.podmanMachine ??
    (family === "linux" || runtimeBinDir === undefined
      ? undefined
      : makeSystemPodmanMachineRunner(
          managedRuntimePodmanArgv0(runtimeBinDir, platform),
          MANAGED_MACHINE_NAME,
          platform,
        ));
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
          arch,
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
          ...(options.artifactDownload !== undefined &&
          options.nftCacheDir !== undefined &&
          runtimeBinDir !== undefined &&
          family === "linux"
            ? {
                nftProvision: {
                  download: options.artifactDownload,
                  cacheDir: options.nftCacheDir,
                  arch,
                },
              }
            : {}),
        })
      : Effect.void;
  const physicalNetworkPlan = (plan: AppPlan): Effect.Effect<AppPlan, ProviderUnavailableError> => {
    if (!shouldManageRuntime || family !== "win32") return Effect.succeed(plan);
    if (machineRunner?.createdAt === undefined) {
      return Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "network",
          message: "The managed Windows Podman machine has no verifiable generation.",
          remediation: "Run `lando setup` and check `podman machine inspect lando` before starting an app.",
        }),
      );
    }
    return machineRunner.createdAt.pipe(
      Effect.flatMap((createdAt) =>
        Effect.try({
          try: () => windowsMachineNetworkPlan(plan, createdAt),
          catch: (cause) =>
            new ProviderUnavailableError({
              providerId,
              operation: "network",
              message: "The app plan refers to a different Windows Podman machine generation.",
              remediation: "Replan the app with the current Lando-managed Podman machine and retry.",
              cause,
            }),
        }),
      ),
    );
  };
  const ensureEffect = ensureEffectFor();
  const ensureBefore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    ensureEffect.pipe(Effect.zipRight(effect));
  const dataPlane =
    podmanApi === undefined
      ? undefined
      : makeProviderDataPlane({
          providerId: LANDO_CTX.providerId,
          prepareWitnessImage: runtimePullImage(podmanApi, VOLUME_WITNESS_IMAGE, {
            ctx: LANDO_CTX,
            dialect: libpodPullDialect,
          }),
          ...(socketPath === undefined
            ? {}
            : { endpointNamespace: socketPath.startsWith("/") ? `unix://${socketPath}` : socketPath }),
          api: podmanApi,
          snapshotMode: "native",
          redactDetails,
          volumeCreationLabels: podmanVolumeCreationLabels,
        });

  const resolvePlan = (appId: AppId): Effect.Effect<AppPlan | undefined, never> => {
    const cached = plans.get(appId);
    if (cached !== undefined) return Effect.succeed(cached);
    if (options.appliedPlanState === undefined) return Effect.succeed(undefined);
    return loadAppliedPlan(options.appliedPlanState, appId).pipe(
      Effect.tap((loaded) =>
        Effect.sync(() => {
          if (loaded !== undefined) plans.set(appId, loaded);
        }),
      ),
    );
  };

  const freshPlanForTeardown = (
    target: Parameters<RuntimeProviderShape["destroy"]>[0],
    requireReceipt: boolean,
  ): Effect.Effect<AppPlan | undefined, ProviderUnavailableError> =>
    Effect.gen(function* () {
      const state = options.appliedPlanState;
      if (state === undefined) {
        if (!requireReceipt) return target.plan ?? (yield* resolvePlan(target.app));
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId,
            operation: "quiesceForFileSync",
            message: "Durable applied app state is unavailable; running writers cannot be verified.",
            remediation: "Recover the applied provider state before stopping an app with file sync.",
          }),
        );
      }
      const prior = yield* inspectAppliedPlan(state, target.app);
      if (prior.status === "unreadable" || (requireReceipt && prior.status === "missing")) {
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId,
            operation: "applied-state.teardown",
            message: "The applied app plan cannot be verified before teardown.",
            remediation: "Recover the saved applied plan and retry without changing app volumes.",
          }),
        );
      }
      if (prior.status === "missing") return target.plan;
      if (target.plan !== undefined && prior.plan.root !== target.plan.root) {
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId,
            operation: "applied-state.teardown",
            message: "The saved applied app plan belongs to a different app root.",
            remediation: "Inspect the applied plan and retry from the original app directory.",
          }),
        );
      }
      return prior.plan;
    });
  const rememberPlan = (plan: AppPlan, reconcile: boolean): Effect.Effect<void, ProviderUnavailableError> => {
    const state = options.appliedPlanState;
    const write = Effect.gen(function* () {
      const previous = reconcile
        ? undefined
        : state === undefined
          ? yield* resolvePlan(plan.id)
          : yield* loadAppliedPlan(state, plan.id);
      const persistedPlan = options.sanitizeAppliedPlan(mergeAppliedPlan(previous, plan, reconcile));
      if (state !== undefined) yield* persistAppliedPlan(state, persistedPlan);
      plans.set(plan.id, persistedPlan);
    });
    return state === undefined
      ? write
      : state.withLock(`applied-plan-${plan.id}`, write).pipe(
          Effect.mapError((cause) =>
            cause instanceof ProviderUnavailableError
              ? cause
              : new ProviderUnavailableError({
                  providerId: LANDO_CTX.providerId,
                  operation: "applied-state.lock",
                  message: "Unable to lock provider-lando applied plan state.",
                  remediation: "Retry after the concurrent app operation completes.",
                  cause,
                }),
          ),
        );
  };

  const forgetPlan = (appId: AppId): Effect.Effect<void, ProviderUnavailableError> => {
    plans.delete(appId);
    return options.appliedPlanState === undefined
      ? Effect.void
      : removeAppliedPlan(options.appliedPlanState, appId);
  };

  const hydratePlansFromDisk: Effect.Effect<void, ProviderUnavailableError> =
    options.appliedPlanState === undefined || options.appliedPlanStateDir === undefined
      ? Effect.void
      : listAppliedPlans(options.appliedPlanState, options.appliedPlanStateDir).pipe(
          Effect.tap((diskPlans) =>
            Effect.sync(() => {
              for (const diskPlan of diskPlans) {
                if (!plans.has(diskPlan.id)) {
                  plans.set(diskPlan.id, diskPlan);
                }
              }
            }),
          ),
          Effect.asVoid,
        );

  return Effect.gen(function* () {
    const processRunnerOption =
      options.processRunner === undefined ? yield* Effect.serviceOption(ProcessRunner) : undefined;
    const processRunner =
      options.processRunner ?? (processRunnerOption?._tag === "Some" ? processRunnerOption.value : undefined);
    const windowsStdinOptions =
      processRunner === undefined
        ? undefined
        : { podmanBin, connectionName: `${MANAGED_MACHINE_NAME}-root`, processRunner };
    const shouldUseWindowsStdinCli = (command: Parameters<typeof runtimeExec>[2]) =>
      family === "win32" &&
      shouldManageRuntime &&
      command.stdinStream !== undefined &&
      command.tty !== true &&
      command.terminalSize === undefined &&
      command.terminalResize === undefined;
    const missingWindowsStdinRunner = (target: Parameters<typeof runtimeExec>[1]) =>
      new ServiceExecError({
        providerId: "lando",
        operation: "exec",
        service: target.service,
        message: "Managed Windows Podman stdin execution requires ProcessRunner.",
        details: { remediation: "Retry with the standard Lando runtime layer." },
      });
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
    const apiOptions = podmanApi === undefined ? {} : { api: podmanApi };
    let reconcileAfterServiceLifecycle: (
      plan: AppPlan,
      target: Parameters<typeof runtimePostServiceLifecycle>[1],
    ) => Effect.Effect<void, ProviderError> = () => Effect.void;
    const resolvedOps = makeResolvedProviderOps({
      ctx: LANDO_CTX,
      resolvePlan,
      noPlanError: makeNoPlanError,
      before: ensureEffect,
      service: {
        lifecycle: (plan, target, action) => {
          const lifecycle = runtimePostServiceLifecycle(plan, target, action, {
            ...apiOptions,
            ctx: LANDO_CTX,
          });
          return withPublishedRecoveryAfterLifecycle(
            action,
            lifecycle,
            reconcileAfterServiceLifecycle(plan, target),
          );
        },
        resume: (target, identity) =>
          runtimePostExactServiceLifecycle(target, identity, "start", { ...apiOptions, ctx: LANDO_CTX }),
        suspend: (target, identity) =>
          runtimePostExactServiceLifecycle(target, identity, "stop", { ...apiOptions, ctx: LANDO_CTX }),
        waitForExit: (plan, target, waitOptions) =>
          runtimeWaitForExit(plan, target, {
            ...apiOptions,
            ctx: LANDO_CTX,
            dialect: libpodWaitDialect,
            ...(waitOptions?.signal === undefined ? {} : { signal: waitOptions.signal }),
          }),
        exec: (plan, target, command) =>
          shouldUseWindowsStdinCli(command)
            ? windowsStdinOptions === undefined
              ? Effect.fail(missingWindowsStdinRunner(target))
              : windowsStdinExec(plan, target, command, windowsStdinOptions)
            : runtimeExec(plan, target, command, { ...apiOptions, ctx: LANDO_CTX }),
        execStream: (plan, target, command) =>
          shouldUseWindowsStdinCli(command)
            ? windowsStdinOptions === undefined
              ? Stream.fail(missingWindowsStdinRunner(target))
              : windowsStdinExecStream(plan, target, command, windowsStdinOptions)
            : runtimeExecStream(plan, target, command, { ...apiOptions, ctx: LANDO_CTX }),
        inspect: (plan, target) => runtimeInspect(plan, target, { ...apiOptions, ctx: LANDO_CTX }),
      },
      ...(dataPlane === undefined ? {} : { dataPlane }),
    });

    const recoveryRequest = podmanApi?.request;
    const recoveryCreatedAt = machineRunner?.createdAt;
    const recoverySnapshot = machineRunner?.publishedRuleSnapshot;
    const recoveryHostOwners = machineRunner?.hostPortOwners;
    const recoveryDeleteRule = machineRunner?.deletePublishedRule;
    const recoveryState = options.appliedPlanState;
    const publishedRecovery =
      shouldManageRuntime &&
      family === "win32" &&
      recoveryRequest !== undefined &&
      recoveryCreatedAt !== undefined &&
      recoverySnapshot !== undefined &&
      recoveryHostOwners !== undefined &&
      recoveryDeleteRule !== undefined &&
      recoveryState !== undefined
        ? makeWindowsPublishedRecovery({
            stateStore: recoveryState,
            machineCreated: recoveryCreatedAt,
            guestSnapshot: recoverySnapshot.pipe(
              Effect.flatMap((snapshot) =>
                snapshot === undefined
                  ? Effect.fail(new Error("The managed machine is not WSL."))
                  : Effect.succeed(snapshot),
              ),
            ),
            hostPortOwners: recoveryHostOwners,
            deleteRule: recoveryDeleteRule,
            facts: (containerId) =>
              Effect.gen(function* () {
                const request = recoveryRequest;
                const containerResponse = yield* request({
                  method: "GET",
                  path: `/containers/${encodeURIComponent(containerId)}/json`,
                });
                if (containerResponse.status < 200 || containerResponse.status >= 300)
                  return yield* Effect.fail(new Error("Published container inspect failed."));
                const container = yield* Effect.try({
                  try: (): unknown => JSON.parse(containerResponse.body),
                  catch: (cause) => cause,
                });
                const networks = (container as { NetworkSettings?: { Networks?: Record<string, unknown> } })
                  .NetworkSettings?.Networks;
                const [networkName] = networks === undefined ? [] : Object.keys(networks);
                if (networkName === undefined)
                  return yield* Effect.fail(new Error("Published network is missing."));
                const [networkResponse, allNetworksResponse, machineCreated, guest] = yield* Effect.all([
                  request({ method: "GET", path: `/networks/${encodeURIComponent(networkName)}` }),
                  request({ method: "GET", path: WINDOWS_COMPAT_NETWORK_LIST_PATH }),
                  recoveryCreatedAt,
                  recoverySnapshot,
                ]);
                if (
                  networkResponse.status < 200 ||
                  networkResponse.status >= 300 ||
                  allNetworksResponse.status < 200 ||
                  allNetworksResponse.status >= 300 ||
                  guest === undefined
                )
                  return yield* Effect.fail(
                    new Error("Published network ownership metadata is unavailable."),
                  );
                return yield* Effect.try({
                  try: () =>
                    publishedFactsFromCompatResponses({
                      containerBody: containerResponse.body,
                      networkBody: networkResponse.body,
                      networkListBody: allNetworksResponse.body,
                      machineCreated,
                      kernelBootId: guest.kernelBootId,
                    }),
                  catch: (cause) =>
                    new ProviderUnavailableError({
                      providerId: LANDO_CTX.providerId,
                      operation: "publishedPortFacts",
                      message: "Podman returned invalid published-port ownership metadata.",
                      remediation: "Inspect the Lando-owned published container and retry.",
                      cause,
                    }),
                });
              }),
          })
        : undefined;
    const reconcilePublishedServices = (
      physicalPlan: AppPlan,
      onlyService?: Parameters<typeof runtimePostServiceLifecycle>[1]["service"],
    ): Effect.Effect<void, ProviderError> =>
      Effect.gen(function* () {
        if (publishedRecovery === undefined || recoverySnapshot === undefined) return;
        const snapshot = yield* recoverySnapshot;
        if (snapshot === undefined) return;
        for (const service of Object.values(physicalPlan.services)) {
          if (onlyService !== undefined && service.name !== onlyService) continue;
          if (
            !supportsWindowsPublishedRecovery({
              appId: physicalPlan.id,
              networks:
                typeof service.extensions.compose === "object" &&
                service.extensions.compose !== null &&
                !Array.isArray(service.extensions.compose)
                  ? (service.extensions.compose as Readonly<Record<string, unknown>>).networks
                  : undefined,
              endpoints: service.endpoints,
            })
          )
            continue;
          const inspected = yield* runtimeInspect(
            physicalPlan,
            { app: physicalPlan.id, service: service.name },
            { ...apiOptions, ctx: LANDO_CTX },
          );
          if (inspected.containerId === undefined) {
            return yield* Effect.fail(
              new ProviderUnavailableError({
                providerId: LANDO_CTX.providerId,
                operation: "reconcilePublishedPorts",
                message: "The running published container has no provider identity.",
                remediation: "Retry after inspecting the Lando-owned Podman container.",
              }),
            );
          }
          yield* publishedRecovery.reconcileAndRecord(inspected.containerId);
        }
      });
    reconcileAfterServiceLifecycle = (plan, target) =>
      physicalNetworkPlan(plan).pipe(
        Effect.flatMap((physicalPlan) => reconcilePublishedServices(physicalPlan, target.service)),
      );
    const occupiedPublishPorts =
      shouldManageRuntime && family === "win32" ? machineRunner?.occupiedPublishPorts : undefined;
    const matchingMachinePorts = machineRunner?.matchingPublishPorts;
    const apiRequest = podmanApi?.request;
    const legacyMatchingPublishPorts = (containerId: string, ports: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        if (apiRequest === undefined || matchingMachinePorts === undefined) return [];
        const response = yield* apiRequest({
          method: "GET",
          path: `/containers/${encodeURIComponent(containerId)}/json`,
        });
        if (response.status < 200 || response.status >= 300) return [];
        const inspected: unknown = yield* Effect.try({
          try: () => JSON.parse(response.body),
          catch: (cause) =>
            new ProviderUnavailableError({
              providerId: ProviderId.make("lando"),
              operation: "matchingPublishPorts",
              message: "Podman returned invalid container network metadata.",
              cause,
            }),
        });
        if (
          typeof inspected !== "object" ||
          inspected === null ||
          !("Id" in inspected) ||
          inspected.Id !== containerId ||
          !("NetworkSettings" in inspected) ||
          typeof inspected.NetworkSettings !== "object" ||
          inspected.NetworkSettings === null ||
          !("Networks" in inspected.NetworkSettings) ||
          typeof inspected.NetworkSettings.Networks !== "object" ||
          inspected.NetworkSettings.Networks === null
        )
          return [];
        const addresses = Object.values(inspected.NetworkSettings.Networks).flatMap((network) =>
          typeof network === "object" &&
          network !== null &&
          "IPAddress" in network &&
          typeof network.IPAddress === "string"
            ? [network.IPAddress]
            : [],
        );
        return yield* matchingMachinePorts(ports, addresses);
      });
    const matchingPublishPorts =
      shouldManageRuntime &&
      family === "win32" &&
      matchingMachinePorts !== undefined &&
      apiRequest !== undefined
        ? (containerId: string, ports: ReadonlyArray<number>) =>
            Effect.gen(function* () {
              const snapshot = recoverySnapshot === undefined ? undefined : yield* recoverySnapshot;
              return publishedRecovery !== undefined && snapshot !== undefined
                ? yield* publishedRecovery.matchingPorts(containerId, ports)
                : yield* legacyMatchingPublishPorts(containerId, ports);
            })
        : undefined;
    const appliedPlanState = options.appliedPlanState;
    const provider: RuntimeProviderWithContainerEvents = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform,
      capabilities: resolvedCapabilities,
      isAvailable: Effect.succeed(true),
      appliedPlans:
        options.appliedPlanState === undefined || options.appliedPlanStateDir === undefined
          ? Effect.succeed([])
          : listAppliedPlans(options.appliedPlanState, options.appliedPlanStateDir),
      ensureReady: ensureEffect,
      ...(family === "win32" && appliedPlanState !== undefined && podmanApi !== undefined
        ? {
            inspectAppliedFileSync: (plan: AppPlan) =>
              ensureEffect.pipe(Effect.zipRight(inspectAppliedFileSync(appliedPlanState, podmanApi, plan))),
          }
        : {}),
      ...(occupiedPublishPorts === undefined ? {} : { occupiedPublishPorts }),
      ...(matchingPublishPorts === undefined ? {} : { matchingPublishPorts }),
      ...(shouldManageRuntime && family === "win32" && stateDir !== undefined
        ? {
            openHostProxyBridge: makeWindowsHostProxyBridge({
              podmanBin,
              stateDir,
              machineName: MANAGED_MACHINE_NAME,
            }),
          }
        : {}),
      ...resolvedOps,
      planSetup: () =>
        shouldManageRuntime && family === "linux"
          ? inspectUidmapSetupPlan({
              platform,
              host: options.linuxHostRelease ?? readLinuxHostRelease(),
              probes: rootlessProbes,
              user: process.env.USER,
              hasSystemd: hasHostSystemd(),
            })
          : shouldManageRuntime &&
              family === "win32" &&
              process.platform === "win32" &&
              Bun.which("ssh.exe") === null
            ? Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "plan-setup",
                  message: "Windows OpenSSH Client is required for Lando container-to-host commands.",
                  remediation:
                    "Install Windows OpenSSH Client in Settings > System > Optional features, then rerun `lando setup`.",
                }),
              )
            : Effect.succeed({ providerId, changes: [] }),
      setup: (plan: ProviderSetupPlan, setupOptions) =>
        Effect.gen(function* () {
          const smokeEnabled = Reflect.get(setupOptions.setupFlags ?? {}, "smoke") === true;
          const result = yield* setupProviderLando({
            ...(podmanApi === undefined ? {} : { podmanApi }),
            ...(options.podmanCommand === undefined ? {} : { podmanCommand: options.podmanCommand }),
            ...(options.podmanMachine === undefined ? {} : { podmanMachine: options.podmanMachine }),
            ...(options.artifactDownload === undefined ? {} : { artifactDownload: options.artifactDownload }),
            ...(options.artifactDownload !== undefined && options.nftCacheDir !== undefined
              ? {
                  nftArtifactDownload: options.artifactDownload,
                  nftCacheDir: options.nftCacheDir,
                }
              : {}),
            platform,
            arch,
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
            ...(smokeEnabled && canEnsure ? { smoke: true } : {}),
            ...(canEnsure
              ? {
                  managedRuntimeSetup: (progress: RuntimeSetupProgress) =>
                    Effect.gen(function* () {
                      if (family === "linux") {
                        yield* progress.run(
                          "prerequisites",
                          applyApprovedProviderSetupPlan(plan, {
                            probes: rootlessProbes,
                            privilege: setupOptions.privilege,
                            user: process.env.USER,
                            hasSystemd: hasHostSystemd(),
                          }).pipe(
                            Effect.andThen(
                              Effect.suspend(() => {
                                const failure = classifyRootlessFailure(rootlessProbes.probe(), undefined, {
                                  hasSystemd: hasHostSystemd(),
                                });
                                return failure === undefined ? Effect.void : Effect.fail(failure);
                              }),
                            ),
                          ),
                        );
                      }
                      yield* ensureEffectFor(progress, progress.runtimeBundleVersion);
                      if (smokeEnabled) {
                        yield* progress.run(
                          "smoke",
                          Effect.scoped(
                            runSmokeReadinessProbe({
                              podmanApi,
                              ...(options.smokeRetryPolicy === undefined
                                ? {}
                                : { retryPolicy: options.smokeRetryPolicy }),
                            }),
                          ),
                        );
                      }
                    }),
                }
              : { readinessCheck: ensureEffect }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
          });
          runtimeVersion = result.podmanVersion;
          bundleVersion = result.runtimeBundleVersion;
        }),
      getStatus: rejectIntelMacHost(platform, arch).pipe(
        Effect.zipRight(
          podmanApi === undefined
            ? Effect.succeed({ running: false, message: "Lando runtime service is not configured." })
            : runtimeServiceStatus.pipe(
                Effect.map((status) => ({
                  running: status.running,
                  message: runtimeStatusMessage(status),
                })),
              ),
        ),
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
          : (spec) =>
              ensureBefore(
                buildContainerArtifact(spec, { providerId: LANDO_CTX.providerId, api: podmanApi }),
              ),
      pullArtifact:
        podmanApi === undefined
          ? () => Effect.fail(makeUnavailable("pullArtifact"))
          : (spec) =>
              ensureBefore(
                runtimePullImage(podmanApi, spec.ref, {
                  ctx: LANDO_CTX,
                  dialect: libpodPullDialect,
                  publish: (event) =>
                    options.eventService?.publish(event).pipe(Effect.catchAll(() => Effect.void)) ??
                    Effect.void,
                }).pipe(
                  Effect.map((result) => ({
                    providerId,
                    ref: result.ref,
                    ...(result.digest === undefined ? {} : { digest: result.digest }),
                  })),
                ),
              ),
      removeArtifact: () => Effect.void,
      apply: (plan, applyOptions) =>
        Effect.gen(function* () {
          yield* ensureEffect;
          const physicalPlan = yield* physicalNetworkPlan(plan);
          const result = yield* runtimeBringUp(physicalPlan, {
            ...(podmanApi === undefined ? {} : { api: podmanApi }),
            ctx: LANDO_CTX,
            startFailureRemediation: makeLandoStartFailureRemediation(platform),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
            ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
            ...(applyOptions.serviceEnvironment === undefined
              ? {}
              : { serviceEnvironment: applyOptions.serviceEnvironment }),
            reconcile: applyOptions.reconcile,
          });
          yield* rememberPlan(applyOptions.recordedPlan ?? plan, applyOptions.reconcile);
          yield* reconcilePublishedServices(physicalPlan);
          return result;
        }),
      quiesceForFileSync: (target) =>
        Effect.gen(function* () {
          const plan = yield* freshPlanForTeardown(target, true);
          if (plan === undefined) {
            return yield* Effect.fail(
              new ProviderUnavailableError({
                providerId,
                operation: "quiesceForFileSync",
                message: "The applied app plan is unavailable; running writers cannot be verified.",
                remediation: "Recover the applied provider state before destroying an app with file sync.",
              }),
            );
          }
          const physicalPlan = yield* physicalNetworkPlan(plan);
          yield* ensureEffect;
          yield* runtimeBringDown(physicalPlan, {
            ...(podmanApi === undefined ? {} : { api: podmanApi }),
            ctx: LANDO_CTX,
            volumes: false,
            purgeCaches: false,
          }).pipe(Effect.asVoid);
        }),
      destroy: (target, destroyOptions) =>
        Effect.gen(function* () {
          const plan = yield* freshPlanForTeardown(target, false);
          if (plan === undefined) return DESTROY_NO_OP;
          const physicalPlan = yield* physicalNetworkPlan(plan);
          yield* ensureEffect.pipe(
            Effect.zipRight(
              runtimeBringDown(physicalPlan, {
                ...(podmanApi === undefined ? {} : { api: podmanApi }),
                ctx: LANDO_CTX,
                volumes: destroyOptions.volumes,
                ...(destroyOptions.purgeCaches === undefined
                  ? {}
                  : { purgeCaches: destroyOptions.purgeCaches }),
              }).pipe(Effect.asVoid),
            ),
          );
          if (destroyOptions.removeState !== false) yield* forgetPlan(target.app);
          return DESTROYED;
        }),
      removeObservedService: (observed) =>
        ensureEffect.pipe(
          Effect.zipRight(
            removeObservedContainer(observed, {
              ...(podmanApi === undefined ? {} : { api: podmanApi }),
              ctx: LANDO_CTX,
            }),
          ),
          Effect.map(observedRemoval),
        ),
      logs: (target, logOptions) =>
        Stream.unwrap(
          (target.plan === undefined ? resolvePlan(target.app) : Effect.succeed(target.plan)).pipe(
            Effect.flatMap((plan) =>
              plan === undefined
                ? Effect.succeed(Stream.fail(makeNoPlanError(target.app, "logs")))
                : ensureEffect.pipe(
                    Effect.as(
                      runtimeLogs(plan, target, logOptions, {
                        ...(podmanApi === undefined ? {} : { api: podmanApi }),
                        ctx: LANDO_CTX,
                        ...(() => {
                          const logFileAccess =
                            options.logFileAccess ??
                            (podmanApi === undefined || logFileHelperPayload === undefined
                              ? undefined
                              : makeDockerLogFileAccess({
                                  providerId: LANDO_CTX.providerId,
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
      list: (filter) =>
        ensureEffect.pipe(
          Effect.zipRight(hydratePlansFromDisk),
          Effect.flatMap(() =>
            Effect.forEach(Array.from(plans.values()), (plan) =>
              Effect.forEach(Object.values(plan.services), (service) =>
                runtimeInspect(
                  plan,
                  { app: plan.id, service: service.name },
                  { ...(podmanApi === undefined ? {} : { api: podmanApi }), ctx: LANDO_CTX },
                ).pipe(
                  Effect.map((snapshot) => ({
                    ...snapshot,
                    appRoot: plan.root,
                    labels: scratchLabelsForPlan(plan),
                  })),
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
    };

    return provider satisfies RuntimeProviderShape;
  });
};

export const makeProviderLayer = (options: ProviderLayerOptions) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

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
        {
          name: "smoke",
          description: "Verify container run, image build, and healthcheck operations during setup.",
          type: "boolean",
        },
      ],
    },
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  doctorChecks: [makeWslMountPropagationCheck()],
  hostMaintainers: [
    {
      id: "lando-runtime-service",
      teardown: ({ paths, platform }) =>
        terminateOwnedRuntimeService(buildManagedRuntimeServiceSpec({ ...paths, platform })),
    },
  ],
  runtimeProviders: new Map([
    [
      ProviderId.make("lando"),
      {
        id: ProviderId.make("lando"),
        appliedPlans: (ctx) =>
          Effect.flatMap(PathsService, (paths) =>
            listAppliedPlans(ctx.stateStore, paths.pluginStateDir(PLUGIN_NAME)),
          ),
        make: (ctx) =>
          Effect.gen(function* () {
            const paths = yield* PathsService;
            const downloader = yield* Downloader;
            const eventService = yield* Effect.serviceOption(EventService);
            const logFileHelperAssets = yield* LogFileHelperAssets;
            const appPlanSanitizer = yield* AppPlanSanitizer;
            const logFileHelperPayloads = yield* logFileHelperAssets.payloads;
            const runtimeState = yield* makePluginRuntimeState(ctx);
            return yield* makeRuntimeProvider({
              platform: paths.platform,
              stateDir: `${paths.roots.userDataRoot}/providers`,
              appliedPlanState: ctx.stateStore,
              appliedPlanStateDir: paths.pluginStateDir(PLUGIN_NAME),
              runtimeBinDir: paths.runtimeBinDir,
              runtimeRunDir: paths.runtimeRunDir,
              runtimeStorageDir: paths.runtimeStorageDir,
              runtimeConfigDir: paths.runtimeConfigDir,
              providerSocketPath: paths.providerSocketPath,
              providerPidPath: paths.providerPidPath,
              artifactDownload: makePluginArtifactDownload(downloader),
              ...(eventService._tag === "Some" ? { eventService: eventService.value } : {}),
              nftCacheDir: paths.toolDownloadsDir("nft"),
              logFileHelperPayloads,
              sanitizeAppliedPlan: appPlanSanitizer.sanitizeForPersistence,
              ...runtimeState,
            });
          }),
      },
    ],
  ]),
});
