import { Context, type Effect, type Scope, type Stream } from "effect";

import type {
  AppResolveError,
  ArtifactBuildError,
  ArtifactTransferError,
  NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderSetupConsentDeniedError,
  ProviderSetupPrivilegeUnavailableError,
  ProviderSetupProvisioningError,
  ProviderSetupUnsupportedHostError,
  ProviderUnavailableError,
  ServiceCopyError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
  VolumeOperationError,
} from "../errors/index.ts";
import type { EndpointInfo } from "../schema/endpoint.ts";
import type {
  AbsolutePath,
  AppId,
  AppPlan,
  DataStoreMountPlan,
  DoctorResourceNameQuery,
  FileSyncSessionSpec,
  HostPlatform,
  HostProxyBridgeInput,
  HostProxyBridgeResult,
  LogSource,
  LogSourceId,
  MountPlan,
  NetworkConfig,
  PortNumber,
  PortablePath,
  ProviderCapabilities,
  ProviderId,
  ProviderSetupPlan,
  ServiceCopyInSpec,
  ServiceCopyOutSpec,
  ServiceName,
  VolumeFilter,
  VolumeIdentity,
  VolumeInfo,
  VolumeLocator,
  VolumeRef,
  VolumeRestoreSpec,
  VolumeSnapshotRef,
  VolumeSnapshotSpec,
} from "../schema/index.ts";
import type { PrivilegeService } from "./process.ts";

export type ProviderError =
  | ArtifactBuildError
  | ProviderCapabilityError
  | ProviderConfigError
  | ProviderInternalError
  | ProviderSetupConsentDeniedError
  | ProviderSetupPrivilegeUnavailableError
  | ProviderSetupProvisioningError
  | ProviderSetupUnsupportedHostError
  | ProviderUnavailableError
  | ServiceExecError
  | ServiceNotFoundError
  | ServiceStartError
  | VolumeOperationError
  | ServiceCopyError
  | ArtifactTransferError;

export type ProviderSelectionError =
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderUnavailableError;

export interface ProviderSetupOptions {
  readonly force: boolean;
  readonly runtimeBundleUrl?: string;
  readonly runtimeBundleSha256?: string;
  readonly network?: NetworkConfig;
  readonly privilege?: Context.Tag.Service<typeof PrivilegeService>;
  /** Parsed values of the setup flags this provider's plugin contributed via `setup.flags`. */
  readonly setupFlags?: Readonly<Record<string, unknown>>;
}

export type ProviderSetupInspectOptions = Omit<ProviderSetupOptions, "privilege">;

export interface ProviderStatus {
  readonly running: boolean;
  readonly message?: string;
}

export interface ProviderVersions {
  readonly provider: string;
  readonly runtime?: string;
  readonly bundle?: string;
}

export interface ArtifactBuildSpec {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly plan: AppPlan;
  readonly buildKey: string;
}

export interface ArtifactRef {
  readonly providerId: ProviderId;
  readonly ref: string;
  readonly digest?: string;
}

export interface ArtifactPullSpec {
  readonly ref: string;
}

export interface ApplyOptions {
  readonly reconcile: boolean;
  readonly recordedPlan?: AppPlan;
  readonly signal?: AbortSignal;
  readonly serviceEnvironment?: ServiceEnvironmentOverrides;
}

export type ServiceEnvironmentOverrides = Readonly<
  Partial<Record<ServiceName, Readonly<Record<string, string>>>>
>;

export interface ApplyResult {
  readonly changed: boolean;
  readonly createdVolumes?: readonly import("../schema/volume-initialization.ts").VolumeCreationFact[];
}

export interface ServiceSelector {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly plan?: AppPlan;
}

export interface ServiceExitResult {
  readonly exitCode: number;
}

export interface WaitForExitOptions {
  readonly signal?: AbortSignal;
}

export interface AppSelector {
  readonly app: AppId;
  readonly plan?: AppPlan;
}

export interface ExecTarget extends ServiceSelector {
  readonly user?: string;
}

export interface CommandSpec {
  readonly command: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: "inherit" | "ignore";
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly tty?: boolean;
  readonly signal?: AbortSignal;
  readonly terminalSize?: { readonly columns: number; readonly rows: number };
  readonly terminalResize?: Stream.Stream<{ readonly columns: number; readonly rows: number }>;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecChunk =
  | { readonly kind: "stdout" | "stderr"; readonly chunk: Uint8Array }
  | { readonly exitCode: number };

export interface EphemeralRunSpec {
  readonly owner?: AppSelector;
  readonly image: string;
  readonly command: ReadonlyArray<string>;
  readonly mounts?: ReadonlyArray<MountPlan | DataStoreMountPlan>;
  readonly stdin?: "inherit" | "ignore";
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly captureStdout?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly remove?: boolean;
}

export interface LogTarget extends ServiceSelector {}

export interface LogOptions {
  readonly follow: boolean;
  readonly tail?: number;
  readonly since?: string;
  /** Resolved declared file sources; the `console` source is always implicit. */
  readonly sources?: ReadonlyArray<LogSource>;
  /** Optional: restrict the stream to one declared source id. */
  readonly source?: LogSourceId;
}

export interface LogChunk {
  readonly service: ServiceName;
  /** Source id; absent means the implicit `console` (container stdout/stderr) source. */
  readonly source?: LogSourceId;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
  readonly timestamp?: Date;
}

export interface ServiceRuntimeInfo {
  readonly app: AppId;
  /** Canonical app root proven by provider-owned runtime metadata. */
  readonly appRoot?: AbsolutePath;
  readonly service: ServiceName;
  readonly providerId: ProviderId;
  readonly status: string;
  /** Container healthcheck status when the provider exposes one. */
  readonly health?: "healthy" | "starting" | "unhealthy";
  readonly state?: string;
  readonly containerId?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly imageIdentity?: string;
  readonly endpoints?: ReadonlyArray<EndpointInfo>;
  readonly lastStartedAt?: Date;
}

export interface ServiceRuntimeIdentity {
  readonly containerId: string;
  readonly imageIdentity: string;
}

export interface ListFilter {
  readonly app?: AppId;
  readonly includeScratch?: boolean;
}

/** Runtime resources owned by one app root that no applied plan accounts for. */
export interface AppliedOrphanGroup {
  readonly providerId: ProviderId;
  readonly appId: AppId;
  readonly services: ReadonlyArray<ServiceRuntimeInfo>;
  readonly volumes: ReadonlyArray<VolumeInfo>;
}

/** What a teardown caller may act on for one app root, before any desired config is loaded. */
export type AppliedTeardownEvidence =
  | { readonly kind: "applied"; readonly plan: AppPlan }
  | { readonly kind: "orphans"; readonly groups: ReadonlyArray<AppliedOrphanGroup> }
  | { readonly kind: "absent" };

export class RuntimeProviderRegistry extends Context.Tag("@lando/core/RuntimeProviderRegistry")<
  RuntimeProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderId>, ProviderUnavailableError>;
    readonly capabilities: Effect.Effect<ProviderCapabilities, ProviderSelectionError>;
    readonly select: (plan?: AppPlan) => Effect.Effect<RuntimeProviderShape, ProviderSelectionError>;
    readonly resolveAppliedPlan?: (
      root: AbsolutePath,
    ) => Effect.Effect<AppPlan | undefined, AppResolveError | ProviderError | NoProviderInstalledError>;
    readonly resolveTeardownEvidence?: (
      root: AbsolutePath,
    ) => Effect.Effect<AppliedTeardownEvidence, AppResolveError | ProviderError | NoProviderInstalledError>;
  }
>() {}

export type AppliedFileSyncInspection =
  | { readonly status: "missing" | "ordinary" | "unknown" }
  | {
      readonly status: "accelerated";
      readonly engineId: string;
      readonly sessions: ReadonlyArray<FileSyncSessionSpec>;
    };
export interface RuntimeProviderShape {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly platform: HostPlatform;
  readonly capabilities: ProviderCapabilities;

  readonly isAvailable: Effect.Effect<boolean, ProviderUnavailableError>;
  readonly appliedPlans?: Effect.Effect<ReadonlyArray<AppPlan>, ProviderError>;
  readonly planSetup: (
    options: ProviderSetupInspectOptions,
  ) => Effect.Effect<ProviderSetupPlan, ProviderError>;
  readonly setup: (
    plan: ProviderSetupPlan,
    options: ProviderSetupOptions,
  ) => Effect.Effect<void, ProviderError, Scope.Scope>;
  /** Ensure a selected provider runtime is reachable before host-dependent planning. */
  readonly ensureReady?: Effect.Effect<void, ProviderError>;
  readonly getStatus: Effect.Effect<ProviderStatus, ProviderError>;
  readonly getVersions: Effect.Effect<ProviderVersions, ProviderError>;
  /** Published TCP ports already bound inside the provider host. This probe is read-only and never starts a runtime. */
  readonly occupiedPublishPorts?: (
    ports: ReadonlyArray<PortNumber>,
  ) => Effect.Effect<ReadonlyArray<PortNumber>, ProviderError>;

  /** Published ports whose guest DNAT claims all target this running container. Optional on split-host providers. */
  readonly matchingPublishPorts?: (
    containerId: string,
    ports: ReadonlyArray<PortNumber>,
  ) => Effect.Effect<ReadonlyArray<PortNumber>, ProviderError>;
  /** Opens a private provider-guest socket to a loopback host-proxy worker for the caller scope. */
  readonly openHostProxyBridge?: (
    input: HostProxyBridgeInput,
  ) => Effect.Effect<HostProxyBridgeResult, ProviderError, Scope.Scope>;

  readonly buildArtifact: (spec: ArtifactBuildSpec) => Effect.Effect<ArtifactRef, ProviderError, Scope.Scope>;
  readonly pullArtifact: (spec: ArtifactPullSpec) => Effect.Effect<ArtifactRef, ProviderError>;
  readonly removeArtifact: (ref: ArtifactRef) => Effect.Effect<void, ProviderError>;

  /** Read prior accelerated mount ownership before a planned fallback can change app mounts. */
  readonly inspectAppliedFileSync?: (
    plan: AppPlan,
  ) => Effect.Effect<AppliedFileSyncInspection, ProviderError>;
  /** Prepare verified accelerated mount targets before app containers start. Providers implementing this must also implement inspectAppliedFileSync. */
  readonly prepareFileSyncTargets?: (
    plan: AppPlan,
  ) => Effect.Effect<{ readonly rollback: Effect.Effect<void, ProviderError> }, ProviderError>;

  readonly apply: (
    plan: AppPlan,
    options: ApplyOptions,
  ) => Effect.Effect<ApplyResult, ProviderError, Scope.Scope>;
  readonly start: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly stop: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly restart: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly resume?: (
    target: ServiceSelector,
    identity: ServiceRuntimeIdentity,
  ) => Effect.Effect<void, ProviderError>;
  readonly suspend?: (
    target: ServiceSelector,
    identity: ServiceRuntimeIdentity,
  ) => Effect.Effect<void, ProviderError>;
  readonly waitForExit: (
    target: ServiceSelector,
    options?: WaitForExitOptions,
  ) => Effect.Effect<ServiceExitResult, ProviderError, Scope.Scope>;
  readonly destroy: (
    target: AppSelector,
    options: DestroyOptions,
  ) => Effect.Effect<DestroyOutcome, ProviderError>;
  /**
   * Stops and removes the single container behind one observation this provider reported from
   * `list`. It never resolves an applied plan, so resources no plan accounts for are addressed by
   * the identity they were observed under. An observation carrying no container id is `absent`.
   */
  readonly removeObservedService: (
    observed: ServiceRuntimeInfo,
  ) => Effect.Effect<ObservedServiceRemoval, ProviderError>;
  /** Stop app writers while keeping accelerated mount targets available for a final sync flush. */
  readonly quiesceForFileSync?: (target: AppSelector) => Effect.Effect<void, ProviderError>;

  readonly exec: (target: ExecTarget, command: CommandSpec) => Effect.Effect<ExecResult, ProviderError>;
  readonly execStream: (
    target: ExecTarget,
    command: CommandSpec,
  ) => Stream.Stream<ExecChunk, ProviderError, Scope.Scope>;
  readonly run: (spec: EphemeralRunSpec) => Effect.Effect<ExecResult, ProviderError, Scope.Scope>;
  readonly runStream: (spec: EphemeralRunSpec) => Stream.Stream<ExecChunk, ProviderError, Scope.Scope>;
  readonly logs: (target: LogTarget, options: LogOptions) => Stream.Stream<LogChunk, ProviderError>;
  readonly inspect: (target: ServiceSelector) => Effect.Effect<ServiceRuntimeInfo, ProviderError>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<ServiceRuntimeInfo>, ProviderError>;

  readonly snapshotVolume: (
    spec: VolumeSnapshotSpec,
  ) => Effect.Effect<VolumeSnapshotRef, ProviderError, Scope.Scope>;
  readonly removeVolumeSnapshot?: (
    snapshot: VolumeSnapshotRef,
  ) => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly restoreVolume: (spec: VolumeRestoreSpec) => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly listVolumes: (filter: VolumeFilter) => Effect.Effect<ReadonlyArray<VolumeInfo>, ProviderError>;
  readonly locateVolume: (ref: VolumeRef) => Effect.Effect<VolumeLocator, ProviderError>;
  readonly inspectResourceNames?: (
    query: DoctorResourceNameQuery,
  ) => Effect.Effect<ReadonlyArray<string>, ProviderError>;
  readonly observeVolume?: (
    target: ServiceSelector,
    destination: PortablePath,
  ) => Effect.Effect<VolumeInfo, ProviderError>;
  readonly adoptVolume?: (
    target: ServiceSelector,
    destination: PortablePath,
  ) => Effect.Effect<VolumeInfo, ProviderError>;
  readonly removeVolume: (
    ref: VolumeRef,
    expectedGeneration: VolumeIdentity["generation"],
  ) => Effect.Effect<void, ProviderError>;
  readonly copyToService: (
    target: ExecTarget,
    spec: ServiceCopyInSpec,
  ) => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly copyFromService: (
    target: ExecTarget,
    spec: ServiceCopyOutSpec,
  ) => Stream.Stream<Uint8Array, ProviderError, Scope.Scope>;
  readonly exportArtifact: (ref: ArtifactRef) => Stream.Stream<Uint8Array, ProviderError, Scope.Scope>;
  readonly importArtifact: (
    data: Stream.Stream<Uint8Array, ProviderError>,
  ) => Effect.Effect<ArtifactRef, ProviderError, Scope.Scope>;
}

export interface DestroyOptions {
  readonly volumes: boolean;
  readonly purgeCaches?: boolean;
  readonly removeState?: boolean;
}

/**
 * What a `destroy` call actually did. A provider handed no plan that finds no applied record for
 * the app removed nothing, and says so, so no caller can read silent success as teardown.
 */
export type DestroyOutcome =
  | { readonly kind: "destroyed" }
  | { readonly kind: "no-op"; readonly reason: "no-applied-plan" };

/** Whether `removeObservedService` removed the container behind an observation, or found none. */
export type ObservedServiceRemoval = { readonly kind: "removed" } | { readonly kind: "absent" };

export class RuntimeProvider extends Context.Tag("@lando/core/RuntimeProvider")<
  RuntimeProvider,
  RuntimeProviderShape
>() {}
