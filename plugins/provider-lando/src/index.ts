/**
 * `@lando/provider-lando` — Lando-managed RuntimeProvider.
 */
import { Duration, Effect, Layer, Schema, Stream } from "effect";

import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { managedRuntimePodmanArgv0 } from "@lando/core/managed-runtime-service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { RetryPolicy } from "@lando/sdk/probe";
import { type AppId, type AppPlan, type HostPlatform, PluginManifest } from "@lando/sdk/schema";
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
import { ensureRuntime } from "./ensure-runtime.ts";
import { exec, execStream } from "./exec.ts";
import { inspect } from "./inspect.ts";
import { logs } from "./logs.ts";
import {
  type PodmanServiceRunner,
  buildPodmanServiceArgs,
  makeSystemPodmanServiceRunner,
} from "./podman-service-runner.ts";
import { redactDetails } from "./redact.ts";
import type { RootlessProbes } from "./rootless-preflight.ts";
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
  makeSystemPodmanMachineRunner,
  setupProviderLando,
} from "./setup.ts";

export {
  appliedPlanPath,
  appliedPlansDir,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "./applied-state.ts";
export { composePath, emitCompose, renderCompose } from "./compose.ts";
export { withApiReason } from "./redact.ts";
export type { EmitComposeOptions, EmitComposeResult } from "./compose.ts";
export { bringUp } from "./bring-up.ts";
export type { BringUpOptions } from "./bring-up.ts";
export { bringDown } from "./bring-down.ts";
export type { BringDownOptions } from "./bring-down.ts";
export { ensureRuntime } from "./ensure-runtime.ts";
export type { EnsureRuntimeDeps } from "./ensure-runtime.ts";
export { exec, execStream } from "./exec.ts";
export type { ExecOptions } from "./exec.ts";
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
export type {
  RootlessPrerequisite,
  RootlessProbeResults,
  RootlessProbes,
} from "./rootless-preflight.ts";
export {
  MINIMUM_PODMAN_VERSION,
  PodmanMachinePrerequisiteError,
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  WindowsMachinePrerequisiteError,
  ensureMacOSPodmanMachine,
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
  RuntimeBundle,
  RuntimeBundleDownloader,
  SetupOptions,
  SetupResult,
} from "./setup.ts";

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
  readonly readinessPolicy?: RetryPolicy;
  readonly eventService?: BringUpOptions["eventService"];
}

interface RuntimeProviderServiceControls {
  readonly getRuntimeServiceStatus: Effect.Effect<RuntimeServiceStatus>;
  readonly teardownRuntimeService: Effect.Effect<{ readonly terminated: boolean; readonly pid?: number }>;
}

type RuntimeProviderWithServiceControls = RuntimeProviderShape & RuntimeProviderServiceControls;

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
  const plans = new Map<string, AppPlan>();
  const externalSocketPath = options.socketPath;
  const managedSocketPath = options.providerSocketPath;
  const socketPath = externalSocketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET ?? managedSocketPath;
  const podmanApi =
    options.podmanApi ??
    (socketPath === undefined ? undefined : (options.podmanApiFactory ?? makePodmanApiClient)(socketPath));
  const stateDir = options.stateDir;
  const runtimeBinDir = options.runtimeBinDir;
  const shouldManageRuntime = externalSocketPath === undefined && managedSocketPath !== undefined;
  const ensureSocketPath = shouldManageRuntime ? managedSocketPath : undefined;
  const podmanBin = runtimeBinDir === undefined ? "podman" : managedRuntimePodmanArgv0(runtimeBinDir);
  const serviceRunner = options.podmanService ?? makeSystemPodmanServiceRunner();
  const skipSetupSocketProbe =
    externalSocketPath === undefined && managedSocketPath !== undefined && options.podmanApi === undefined;
  let runtimeVersion: string | undefined;
  let bundleVersion: string | undefined;
  const platform = options.platform ?? currentHostPlatform();
  if (platform === undefined) {
    return Effect.fail(unsupportedHostPlatformError());
  }
  const machineRunner =
    options.podmanMachine ??
    (platform === "linux" ? undefined : makeSystemPodmanMachineRunner(undefined, undefined, platform));
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
  const shouldProbeCapabilities = options.podmanApi !== undefined || externalSocketPath !== undefined;
  const capabilities =
    shouldProbeCapabilities && podmanApi !== undefined
      ? introspectProviderCapabilities(podmanApi, platform)
      : Effect.succeed(mvpProviderCapabilities(platform));
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
    plans.set(plan.id, plan);
    return stateDir === undefined ? Effect.void : persistAppliedPlan(stateDir, plan).pipe(Effect.asVoid);
  };

  const forgetPlan = (appId: AppId): Effect.Effect<void> => {
    plans.delete(appId);
    return stateDir === undefined ? Effect.void : removeAppliedPlan(stateDir, appId);
  };

  return capabilities.pipe(
    Effect.flatMap((resolvedCapabilities) =>
      Effect.gen(function* () {
        const canEnsure =
          podmanApi !== undefined &&
          shouldManageRuntime &&
          ensureSocketPath !== undefined &&
          options.runtimeStorageDir !== undefined &&
          options.runtimeRunDir !== undefined &&
          options.runtimeConfigDir !== undefined &&
          options.providerPidPath !== undefined;
        const ensureEffect: Effect.Effect<void, ProviderUnavailableError> = canEnsure
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
              ...(options.rootlessProbes === undefined ? {} : { rootlessProbes: options.rootlessProbes }),
              ...(options.readinessPolicy === undefined ? {} : { readinessPolicy: options.readinessPolicy }),
            })
          : Effect.void;
        const [cachedEnsure, invalidateEnsure] = yield* Effect.cachedInvalidateWithTTL(
          ensureEffect,
          Duration.infinity,
        );
        const ensureOnce = cachedEnsure.pipe(Effect.tapError(() => invalidateEnsure));
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
                runtimeBinDir,
                runtimeStorageDir: options.runtimeStorageDir,
                runtimeRunDir: options.runtimeRunDir,
                runtimeConfigDir: options.runtimeConfigDir,
                providerSocketPath: managedSocketPath,
                providerPidPath: options.providerPidPath,
              }
            : undefined;

        const provider: RuntimeProviderWithServiceControls = {
          id: "lando",
          displayName: "Lando Runtime Provider",
          version: "0.0.0",
          platform,
          capabilities: resolvedCapabilities,
          isAvailable: Effect.succeed(true),
          setup: (setupOptions) =>
            Effect.gen(function* () {
              const result = yield* setupProviderLando({
                ...(podmanApi === undefined ? {} : { podmanApi }),
                ...(options.podmanCommand === undefined ? {} : { podmanCommand: options.podmanCommand }),
                ...(machineRunner === undefined ? {} : { podmanMachine: machineRunner }),
                ...(options.artifactDownload === undefined
                  ? {}
                  : { artifactDownload: options.artifactDownload }),
                platform,
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
                ...(options.runtimeConfigDir === undefined
                  ? {}
                  : { runtimeConfigDir: options.runtimeConfigDir }),
                ...(socketPath === undefined ? {} : { socketPath }),
                ...(skipSetupSocketProbe ? { skipSocketProbe: true } : {}),
                readinessCheck: ensureOnce,
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
          teardownRuntimeService:
            managedRuntimeServicePaths === undefined
              ? Effect.succeed({ terminated: false })
              : teardownManagedRuntimeService({ paths: managedRuntimeServicePaths }),
          getVersions: Effect.sync(() => ({
            provider: "0.0.0",
            ...(runtimeVersion === undefined ? {} : { runtime: runtimeVersion }),
            ...(bundleVersion === undefined ? {} : { bundle: bundleVersion }),
          })),
          buildArtifact: () => Effect.fail(makeUnavailable("buildArtifact")),
          pullArtifact: () => Effect.fail(makeUnavailable("pullArtifact")),
          removeArtifact: () => Effect.void,
          apply: (plan, applyOptions) =>
            Effect.gen(function* () {
              yield* ensureOnce;
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
              yield* ensureOnce;
              yield* bringDown(plan, {
                ...(podmanApi === undefined ? {} : { podmanApi }),
                volumes: destroyOptions.volumes,
                ...(destroyOptions.purgeCaches === undefined
                  ? {}
                  : { purgeCaches: destroyOptions.purgeCaches }),
              });
              if (destroyOptions.removeState !== false) {
                yield* forgetPlan(target.app);
              }
            }),
          exec: (target, command) =>
            Effect.gen(function* () {
              yield* ensureOnce;
              const plan = yield* resolvePlan(target);
              if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "exec"));
              return yield* exec(plan, target, command, {
                ...(podmanApi === undefined ? {} : { podmanApi }),
              });
            }),
          execStream: (target, command) =>
            Stream.unwrap(
              ensureOnce.pipe(
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
          run: dataPlane === undefined ? () => Effect.fail(makeUnavailable("run")) : dataPlane.run,
          runStream:
            dataPlane === undefined ? () => Stream.fail(makeUnavailable("runStream")) : dataPlane.runStream,
          logs: (target, logOptions) =>
            Stream.unwrap(
              resolvePlan(target).pipe(
                Effect.flatMap((plan) =>
                  plan === undefined
                    ? Effect.succeed(Stream.fail(makeNoPlanError(target.app, "logs")))
                    : ensureOnce.pipe(
                        Effect.as(
                          logs(plan, target, logOptions, {
                            ...(podmanApi === undefined ? {} : { podmanApi }),
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
              yield* ensureOnce;
              return yield* inspect(plan, target, {
                ...(podmanApi === undefined ? {} : { podmanApi }),
              });
            }),
          list: (filter) =>
            ensureOnce.pipe(
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
              : dataPlane.snapshotVolume,
          restoreVolume:
            dataPlane === undefined
              ? () => Effect.fail(makeUnavailable("restoreVolume"))
              : dataPlane.restoreVolume,
          listVolumes:
            dataPlane === undefined
              ? () => Effect.fail(makeUnavailable("listVolumes"))
              : dataPlane.listVolumes,
          removeVolume:
            dataPlane === undefined
              ? () => Effect.fail(makeUnavailable("removeVolume"))
              : dataPlane.removeVolume,
          copyToService:
            dataPlane === undefined
              ? () => Effect.fail(makeUnavailable("copyToService"))
              : dataPlane.copyToService,
          copyFromService:
            dataPlane === undefined
              ? () => Stream.fail(makeUnavailable("copyFromService"))
              : dataPlane.copyFromService,
          exportArtifact:
            dataPlane === undefined
              ? () => Stream.fail(makeUnavailable("exportArtifact"))
              : dataPlane.exportArtifact,
          importArtifact:
            dataPlane === undefined
              ? () => Effect.fail(makeUnavailable("importArtifact"))
              : dataPlane.importArtifact,
        };

        return provider satisfies RuntimeProviderShape;
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
