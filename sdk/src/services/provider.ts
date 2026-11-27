import { Context, type Effect, type Redacted, Schema, type Scope, type Stream } from "effect";
import type {
  AppResolveError,
  AppliedStateVersionError,
  ArtifactBuildError,
  ArtifactTransferError,
  EnvironmentValueResolutionError,
  HealthcheckTargetUnsupportedError,
  NoProviderInstalledError,
  PlanReplanRequiredError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderSetupUnsupportedHostError,
  ProviderUnavailableError,
  SecretStoreError,
  ServiceCopyError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
  VolumeOperationError,
} from "../errors/index.ts";
import type { PublicationObservation } from "../schema/endpoint.ts";
import type {
  AbsolutePath,
  AgentSocketBridgeInput,
  AgentSocketBridgeResult,
  AppId,
  AppPlan,
  AppRef,
  AppliedStateInventory,
  ArtifactListing,
  ArtifactRemoval,
  ArtifactRemovalRequest,
  ArtifactSelector,
  DoctorResourceNameQuery,
  FileSyncSessionSpec,
  HealthcheckPlan,
  HostPlatform,
  HostProxyBridgeInput,
  HostProxyBridgeResult,
  LogSource,
  LogSourceId,
  NetworkConfig,
  PortNumber,
  PortablePath,
  PreparedFileSyncTarget,
  ProviderArtifactRef,
  ProviderCapabilities,
  ProviderId,
  RetainedFileSyncQuiescence,
  ServiceContainerChange,
  ServiceCopyInSpec,
  ServiceCopyOutSpec,
  ServiceName,
  ServicePlan,
  ServiceRunObservation,
  VolumeCreationFact,
  VolumeFilter,
  VolumeIdentity,
  VolumeInfo,
  VolumeLocator,
  VolumeMountPlan,
  VolumeRef,
  VolumeRestoreSpec,
  VolumeSnapshotArtifact,
  VolumeSnapshotRef,
  VolumeSnapshotSpec,
} from "../schema/index.ts";
import type { OwnedResourcesCleanupResult, ResourceOwnership } from "../schema/resource-ownership.ts";
import type { MountObservation } from "../schema/service-mount.ts";
import type {
  BringDownOptions,
  BringDownOutcome,
  ContainerDisposition,
  FileSyncQuiesceResult,
  ObservedBringDown,
} from "../schema/service-shutdown.ts";

export type {
  BringDownOptions,
  BringDownOutcome,
  ContainerDisposition,
  FileSyncQuiesceResult,
  ObservedBringDown,
} from "../schema/service-shutdown.ts";

import type { HostChangeApplier, HostChangeApplyError, HostChangeProposal } from "./host-change.ts";
import type { ProcessResult } from "./process.ts";

export type ProviderError =
  | HealthcheckTargetUnsupportedError
  | PlanReplanRequiredError
  | EnvironmentValueResolutionError
  | SecretStoreError
  | ArtifactBuildError
  | ProviderCapabilityError
  | ProviderConfigError
  | ProviderInternalError
  | ProviderSetupUnsupportedHostError
  | ProviderUnavailableError
  | AppliedStateVersionError
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

export interface ProviderSetupInspectOptions {
  readonly force: boolean;
  readonly runtimeBundleUrl?: string;
  readonly runtimeBundleSha256?: string;
  readonly network?: NetworkConfig;
  /** Parsed values of the setup flags this provider's plugin contributed via `setup.flags`. */
  readonly setupFlags?: Readonly<Record<string, unknown>>;
}

export interface ProviderSetupOptions extends ProviderSetupInspectOptions {
  /** The run's approved host changes; the provider applies the ones it planned, in its own order. */
  readonly hostChanges?: HostChangeApplier;
}

/** Idle proves no workloads are running, but does not describe stored resources. */
export const ProviderStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), message: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ state: Schema.Literal("idle"), message: Schema.optionalKey(Schema.String) }),
]);
export type ProviderStatus = typeof ProviderStatus.Type;

export interface ProviderVersions {
  readonly provider: string;
  readonly runtime?: string;
  readonly bundle?: string;
}

export interface ArtifactBuildContextTree {
  readonly contextName: string;
  readonly destination: string;
  readonly root: string;
  readonly digest: string;
}

export interface ArtifactBuildRequest {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly plan: AppPlan;
  readonly buildKey: string;
  /**
   * The name the produced artifact carries. The engine chooses it per data root, provider, service, and
   * build key, so it can later remove exactly what it built.
   */
  readonly ref: string;
  /** Engine-chosen labels the provider sets on every image the build produces. */
  readonly labels: Readonly<Record<string, string>>;
  readonly contextTrees?: ReadonlyArray<ArtifactBuildContextTree>;
  /**
   * Receives the build's output text in arrival order: unredacted and not aligned to lines. The provider
   * awaits each call before reading further, delivers every call before `buildArtifact` returns, and
   * fails with the sink's error when the sink fails.
   */
  readonly onOutput?: (text: string) => Effect.Effect<void, ProviderInternalError>;
}

export type { ProviderArtifactRef } from "../schema/artifacts.ts";

export type ArtifactPullPolicy = "always" | "missing" | "never";

export interface ArtifactPullSpec {
  readonly ref: string;
  /**
   * `always` (the default when omitted) acquires from the artifact's source;
   * `missing` reuses a provider-local copy and acquires only when absent;
   * `never` reuses a provider-local copy and fails without contacting the source when absent.
   */
  readonly policy?: ArtifactPullPolicy;
  /** Platform to acquire, in os/arch or os/arch/variant form; omitted lets the engine choose its default. */
  readonly platform?: string;
}

export interface ApplyOptions {
  /**
   * When true, the plan names every service of the app, so the provider persists it (or
   * `recordedPlan` when given) as the whole applied record instead of carrying previous
   * services it does not name. `reconcile` only forces container recreation.
   */
  readonly complete?: boolean;
  readonly reconcile: boolean;
  readonly recordedPlan?: AppPlan;
  /** Full dependency graph for completion-intent classification during partial apply; not recorded state. */
  readonly completionPlan?: AppPlan;
  readonly signal?: AbortSignal;
  readonly executeReadinessAttempt?: (
    serviceName: ServiceName,
    probe: HealthcheckPlan,
  ) => Effect.Effect<ProcessResult, ProviderError>;
  /**
   * Continue a green `service_healthy` edge before actually starting or replacing its consumer.
   * Never called for kept consumers, non-green gates, or dependencies outside this apply.
   * Await it under the caller's apply context. A returned rejection blocks only a required edge;
   * it does not mean the probe failed and does not describe the resulting state of either container.
   */
  readonly continueHealthyDependency?: (input: {
    readonly consumer: ServiceName;
    readonly dependency: ServiceName;
    readonly containerId: string;
    readonly createdVolumes: readonly VolumeCreationFact[];
  }) => Effect.Effect<ServiceStartError | undefined, ProviderError>;
  readonly resolveServiceEnvironment?: (
    service: ServicePlan,
  ) => Effect.Effect<Readonly<Record<string, string>>, ProviderError>;
  /** Await each verified creation before starting services; failure aborts apply. Never called for adoption. */
  readonly onVolumeCreated?: (
    fact: import("../schema/volume-initialization.ts").VolumeCreationFact,
  ) => Effect.Effect<void, ProviderError>;
}

export interface ApplyResult {
  readonly changed: boolean;
  readonly createdVolumes?: readonly import("../schema/volume-initialization.ts").VolumeCreationFact[];
  /**
   * What apply did to each executed service's container. Providers that cannot report a
   * container-level outcome omit it, and consumers then announce nothing and add no
   * `container` field rather than guessing.
   */
  readonly services?: Readonly<Record<string, ServiceContainerChange>>;
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
  readonly expectedContainerId?: string;
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
  /** Internal operation: skip umask wrapping and process supervision. Never set for user payloads. */
  readonly raw?: boolean;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecChunk =
  | { readonly kind: "stdout" | "stderr"; readonly chunk: Uint8Array }
  | { readonly exitCode: number };

export const EphemeralBindMount = Schema.Struct({
  source: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  readOnly: Schema.optionalKey(Schema.Boolean),
});
export type EphemeralBindMount = typeof EphemeralBindMount.Type;

export const EphemeralMountSource = Schema.Struct({
  containerId: Schema.NonEmptyString,
  readOnly: Schema.Boolean,
});
export type EphemeralMountSource = typeof EphemeralMountSource.Type;

export interface EphemeralRunSpec {
  readonly owner?: AppSelector;
  readonly image: string;
  readonly command: ReadonlyArray<string>;
  readonly mounts?: ReadonlyArray<VolumeMountPlan>;
  readonly binds?: ReadonlyArray<EphemeralBindMount>;
  /** Borrow the realized mounts of an existing service container. */
  readonly mountsFrom?: EphemeralMountSource;
  readonly user?: string;
  /**
   * Runtime user-namespace mode the helper must share with the container
   * whose mounts it borrows (for example `keep-id:uid=33,gid=33`). Without
   * it, `user` ids resolve inside a different namespace and files land on
   * subordinate host ids.
   */
  readonly usernsMode?: string;
  readonly entrypoint?: ReadonlyArray<string>;
  readonly stdin?: "inherit" | "ignore";
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly captureStdout?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly remove?: boolean;
}

/**
 * One staged replacement of a volume's contents. The provider owns staging,
 * extraction, publication, and cleanup; the caller supplies only the archive and
 * the last fallible check before anything live changes.
 */
export interface VolumeArchiveImportSpec<E, R> {
  readonly target: VolumeRef;
  /** Uncompressed tar of the volume's contents, excluding Lando's reserved root entries. */
  readonly archive: Stream.Stream<Uint8Array, E, R>;
  /**
   * Runs exactly once after the archive completed, was validated and extracted, and
   * before publication. A failure leaves the live contents unchanged.
   */
  readonly beforeCommit: Effect.Effect<void, E, R>;
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

/** Identity and non-run-state evidence from one container inspection or listing. */
export interface ServiceRuntimeFields {
  readonly app: AppId;
  /** Canonical app root proven by provider-owned runtime metadata. */
  readonly appRoot?: AbsolutePath;
  readonly service: ServiceName;
  readonly providerId: ProviderId;
  /** Native container identity: stable across in-place restarts, different after replacement.
   * Omission means consumers cannot prove that container-local work can be reused. */
  readonly containerId?: string;
  readonly nativeName?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly imageIdentity?: string;
  readonly publications: PublicationObservation;
  /** Mount table from the same container inspection, absent when unsupported. */
  readonly mounts?: MountObservation;
  readonly lastStartedAt?: Date;
}

/**
 * One provider observation of a service container. Run state is the closed
 * {@link ServiceRunObservation} (`status`, plus `health` only while running and `exitCode` only
 * once exited), normalized by the provider so consumers never reconcile engine spellings.
 */
export type ServiceRuntimeInfo = ServiceRuntimeFields & ServiceRunObservation;

export interface ServiceRuntimeIdentity {
  readonly containerId: string;
  readonly imageIdentity: string;
}

export interface ListFilter {
  readonly app?: AppId;
  readonly includeScratch?: boolean;
  /** Also report Lando-labeled containers no applied plan accounts for. Used by applied-state
   * evidence and host-wide observation; providers that already discover by label may ignore this flag. */
  readonly includeUnplanned?: boolean;
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
  | {
      readonly kind: "applied";
      readonly plan: AppPlan;
      readonly ownership?: ReadonlyArray<ResourceOwnership>;
    }
  | {
      readonly kind: "orphans";
      readonly groups: ReadonlyArray<AppliedOrphanGroup>;
      readonly ownership?: ReadonlyArray<ResourceOwnership>;
    }
  | { readonly kind: "owned"; readonly ownership: ReadonlyArray<ResourceOwnership> }
  | { readonly kind: "absent" };

/**
 * How far applied-plan resolution may widen from the lookup root. `"ancestor"` accepts the
 * deepest applied plan whose app root contains the lookup root, which suits a working
 * directory inside an app; `"exact"` requires the plan recorded for that root itself and is
 * what a caller that already resolved its app must use.
 */
export type AppliedPlanLookup = "ancestor" | "exact";

/** Read-only host-wide evidence; an unobserved runtime contributes only applied plans. */
export interface ProviderRuntimeSnapshot {
  readonly providerId: ProviderId;
  readonly runtimeObserved: boolean;
  readonly appliedPlans: ReadonlyArray<AppPlan>;
  readonly services: ReadonlyArray<ServiceRuntimeInfo>;
  readonly volumes: ReadonlyArray<VolumeInfo>;
}

export class RuntimeProviderRegistry extends Context.Service<
  RuntimeProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderId>, ProviderUnavailableError>;
    readonly capabilities: Effect.Effect<ProviderCapabilities, ProviderSelectionError>;
    /**
     * Applied plans, across every installed provider contribution, whose `identity.appRoot` exactly
     * equals `root`. Callers pass a canonical root. Filesystem-only: never constructs, initializes,
     * or contacts a runtime. With `providerId`, only that provider's applied state is read.
     */
    readonly appliedPlansFor: (
      root: AbsolutePath,
      options?: { readonly providerId?: ProviderId; readonly observe?: true },
    ) => Effect.Effect<
      ReadonlyArray<AppPlan>,
      ProviderUnavailableError | AppliedStateVersionError | NoProviderInstalledError
    >;
    /** Strict host-wide inventory for one provider, preserving unreadable ownership records.
     * Filesystem-only: never constructs, initializes, or contacts a runtime. */
    readonly appliedStateInventory: (
      providerId: ProviderId,
    ) => Effect.Effect<
      AppliedStateInventory,
      ProviderUnavailableError | AppliedStateVersionError | NoProviderInstalledError
    >;
    readonly hasRecordedOwnership?: (
      providerId: ProviderId,
    ) => Effect.Effect<boolean, ProviderUnavailableError | NoProviderInstalledError>;
    /** Filesystem-only targeted read. Returns undefined only when the app has no record. */
    readonly readAppliedPlanStrict: (
      target: Pick<AppPlan, "id" | "provider">,
    ) => Effect.Effect<
      AppPlan | undefined,
      ProviderUnavailableError | AppliedStateVersionError | NoProviderInstalledError
    >;
    readonly select: (
      target?: AppPlan | ProviderId,
    ) => Effect.Effect<RuntimeProviderShape, ProviderSelectionError>;
    readonly resourceOwnership?: (
      providerId: ProviderId,
      root: AbsolutePath,
    ) => Effect.Effect<ResourceOwnership | undefined, ProviderUnavailableError | NoProviderInstalledError>;
    /** Every ownership inventory one provider recorded, read from the filesystem only. */
    readonly listResourceOwnership?: (
      providerId: ProviderId,
    ) => Effect.Effect<ReadonlyArray<ResourceOwnership>, ProviderUnavailableError | NoProviderInstalledError>;
    /**
     * The applied plan for a lookup root, failing closed on contradictory state. With no matching
     * plan the root is not applied (`undefined`) unless workloads may still run there: containers
     * a running runtime reports, recorded containers on a runtime that could not be checked, or an
     * ownership record that does not name its resources. Retained volumes and recorded networks
     * never block. With the default `"ancestor"` lookup a working directory inside an app
     * resolves that app; `"exact"` never returns an enclosing app's plan.
     */
    readonly resolveAppliedPlan: (
      root: AbsolutePath,
      app?: Pick<AppRef, "kind" | "id">,
      lookup?: AppliedPlanLookup,
    ) => Effect.Effect<AppPlan | undefined, AppResolveError | ProviderError | NoProviderInstalledError>;
    readonly resolveTeardownEvidence: (
      root: AbsolutePath,
      app?: Pick<AppRef, "kind" | "id">,
    ) => Effect.Effect<AppliedTeardownEvidence, AppResolveError | ProviderError | NoProviderInstalledError>;
    readonly observeRuntime?: Effect.Effect<
      ReadonlyArray<ProviderRuntimeSnapshot>,
      AppResolveError | ProviderError | NoProviderInstalledError
    >;
  }
>()("@lando/core/RuntimeProviderRegistry") {}

export type AppliedFileSyncInspection =
  | { readonly status: "missing" | "ordinary" | "unknown" }
  | {
      readonly status: "accelerated";
      readonly engineId: string;
      readonly sessions: ReadonlyArray<FileSyncSessionSpec>;
    };
export class RuntimeProvider extends Context.Service<
  RuntimeProvider,
  {
    readonly id: string;
    readonly displayName: string;
    readonly version: string;
    readonly platform: HostPlatform;
    /** Engine endpoint this provider talks to. Pull checks are keyed by it, not by provider id alone. */
    readonly runtimeIdentity?: string;
    readonly capabilities: ProviderCapabilities;
    /** Apply honors the healthy-dependency continuation contract. Omission means unsupported. */
    readonly healthyDependencyContinuation?: true;

    readonly isAvailable: Effect.Effect<boolean, ProviderUnavailableError>;
    readonly appliedPlans?: Effect.Effect<ReadonlyArray<AppPlan>, ProviderError>;
    readonly cleanupOwnedResources?: (
      root: AbsolutePath,
      options: OwnedResourcesCleanupOptions,
    ) => Effect.Effect<OwnedResourcesCleanupResult, ProviderError>;
    /**
     * Inspect the host read-only and propose the host changes setup needs. Never mutates the
     * host, downloads, or prompts. Absent means the provider needs no host changes.
     */
    readonly planHostChanges?: (
      options: ProviderSetupInspectOptions,
    ) => Effect.Effect<ReadonlyArray<HostChangeProposal>, ProviderError>;
    readonly setup: (
      options: ProviderSetupOptions,
    ) => Effect.Effect<void, ProviderError | HostChangeApplyError, Scope.Scope>;
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
    ) => Effect.Effect<
      HostProxyBridgeResult & { readonly exited: Promise<number> },
      ProviderError,
      Scope.Scope
    >;
    /** Delivers the named agent socket through provider-owned resources released with the caller scope. */
    readonly openAgentSocketBridge?: (
      input: AgentSocketBridgeInput,
    ) => Effect.Effect<AgentSocketBridgeResult, ProviderError, Scope.Scope>;

    readonly buildArtifact: (
      spec: ArtifactBuildRequest,
    ) => Effect.Effect<ProviderArtifactRef, ProviderError, Scope.Scope>;
    readonly pullArtifact: (spec: ArtifactPullSpec) => Effect.Effect<ProviderArtifactRef, ProviderError>;
    /**
     * Removes exactly the requested image ref or ID. With pruneParents, the runtime may also reclaim
     * dangling parents; otherwise parent pruning is disabled. Never forces and never starts a runtime.
     * A container conflict is reported as `in-use` with container names; a missing image is `absent`.
     */
    readonly removeArtifact: (
      request: ArtifactRemovalRequest,
    ) => Effect.Effect<ArtifactRemoval, ProviderError>;
    /**
     * Lists images whose labels all match, like the engine's default image listing: tagged images and
     * dangling untagged leaves, never parents that still have children. Never starts a runtime;
     * an unreachable runtime fails with ProviderUnavailableError.
     */
    readonly listArtifacts: (
      selector: ArtifactSelector,
    ) => Effect.Effect<ReadonlyArray<ArtifactListing>, ProviderUnavailableError | ProviderInternalError>;

    /** Read prior accelerated mount ownership before a planned fallback can change app mounts. */
    readonly inspectAppliedFileSync?: (
      plan: AppPlan,
    ) => Effect.Effect<AppliedFileSyncInspection, ProviderError>;
    /** Prepare verified accelerated mount targets before app containers start. Providers implementing this must also implement inspectAppliedFileSync. Targets outlive a failed start; the next start resumes them. */
    readonly prepareFileSyncTargets?: (plan: AppPlan) => Effect.Effect<
      {
        readonly targets: ReadonlyArray<PreparedFileSyncTarget>;
      },
      ProviderError
    >;
    /** Stop and prove absence of writers on retained sync targets when no applied plan receipt exists. */
    readonly quiesceRetainedFileSync?: (
      plan: AppPlan,
    ) => Effect.Effect<RetainedFileSyncQuiescence, ProviderError>;
    /** Remove verified prepared sync resources after durable sessions are disposed. */
    readonly disposeFileSyncTargets?: (plan: AppPlan) => Effect.Effect<void, ProviderError>;

    readonly apply: (
      plan: AppPlan,
      options: ApplyOptions,
    ) => Effect.Effect<ApplyResult, ProviderError, Scope.Scope>;
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
    /**
     * Brings down every container the app's services own: planned names inspected with adoption
     * receipts plus owned containers still carrying an earlier name, deduplicated by native id.
     * `stop` stops each one and keeps containers, networks, volumes, and applied state. `remove`
     * deletes containers and networks, volumes as requested, and forgets applied state unless
     * `removeState` is false. With no plan given and none applied, the outcome is `no-op`.
     */
    readonly bringDown: (
      target: AppSelector,
      options: BringDownOptions,
    ) => Effect.Effect<BringDownOutcome, ProviderError>;
    /**
     * Stops, or stops and removes, the single container behind one observation this provider
     * reported from `list`. The container is addressed by its native id, never by a plan: the app's
     * applied state is read only to refuse an unreadable record and to learn the data root, and the
     * container's live labels must prove the observed app, root, service, provider, and data root
     * before anything changes. An observation carrying no container id is `absent`.
     */
    readonly bringDownObserved: (
      observed: ServiceRuntimeInfo,
      containers: ContainerDisposition,
    ) => Effect.Effect<ObservedBringDown, ProviderError>;
    /** Stop app writers while keeping accelerated mount targets available for a final sync flush. */
    readonly quiesceForFileSync?: (
      target: AppSelector,
    ) => Effect.Effect<FileSyncQuiesceResult, ProviderError>;

    /**
     * Read only requested environment names from existing service containers. Absent containers,
     * missing names and empty values contribute nothing. Never start a runtime or mutate resources.
     * Failures must be typed, sanitized ProviderErrors without response bodies.
     */
    readonly readAppEnvironment: (
      target: AppSelector,
      names: Readonly<Record<string, ReadonlyArray<string>>>,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, ProviderError>;
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

    /**
     * Captures a native volume snapshot. Requires the caller to hold the
     * physical-volume lock for the source; DataMover is the caller that does.
     */
    readonly snapshotVolume: (
      spec: VolumeSnapshotSpec,
    ) => Effect.Effect<VolumeSnapshotRef, ProviderError, Scope.Scope>;
    /** Idempotently remove a snapshot. GC disables runtime startup/repair; purge allows it by default. */
    readonly removeVolumeSnapshot: (
      snapshot: VolumeSnapshotRef,
      options?: { readonly startRuntime?: boolean },
    ) => Effect.Effect<void, ProviderError, Scope.Scope>;
    /** List native snapshot images without consulting a host snapshot index. */
    readonly listVolumeSnapshots?: () => Effect.Effect<ReadonlyArray<VolumeSnapshotArtifact>, ProviderError>;
    /**
     * Restore a native snapshot into a target volume. `beforeCommit`, when given, runs
     * after staging and target verification and immediately before publication. Requires
     * the caller to hold the physical-volume lock for the target; DataMover is the caller
     * that does.
     */
    readonly restoreVolume: <E = never>(
      spec: VolumeRestoreSpec,
      options?: { readonly beforeCommit?: Effect.Effect<void, E> },
    ) => Effect.Effect<void, ProviderError | E, Scope.Scope>;
    /**
     * Streams the volume's contents as an uncompressed tar, excluding Lando's reserved
     * root entries. Requires the caller to hold the physical-volume lock for this
     * volume; DataMover is the caller that does.
     */
    readonly exportVolume: (ref: VolumeRef) => Stream.Stream<Uint8Array, ProviderError, Scope.Scope>;
    /**
     * Replaces the volume's contents in one operation: stage and extract the archive
     * inside the volume, validate it inline, run `beforeCommit`, then publish and dispose
     * of the previous contents. A failure or interruption before publication leaves the
     * live contents unchanged and removes staging. Requires the caller to hold the
     * physical-volume lock for the target; DataMover is the caller that does.
     */
    readonly importVolume: <E, R>(
      spec: VolumeArchiveImportSpec<E, R>,
    ) => Effect.Effect<void, ProviderError | E, Scope.Scope | R>;
    readonly listVolumes: (filter: VolumeFilter) => Effect.Effect<ReadonlyArray<VolumeInfo>, ProviderError>;
    readonly locateVolume: (ref: VolumeRef) => Effect.Effect<VolumeLocator, ProviderError>;
    readonly adoptDataRoot?: (
      plan: AppPlan,
      volumeWitness: (coordinationKey: string) => Effect.Effect<string | undefined, ProviderError>,
    ) => Effect.Effect<void, ProviderError>;
    readonly inspectResourceNames?: (
      query: DoctorResourceNameQuery,
    ) => Effect.Effect<ReadonlyArray<string>, ProviderError>;
    readonly observeVolume?: (
      target: ServiceSelector,
      destination: PortablePath,
    ) => Effect.Effect<VolumeInfo, ProviderError>;
    /**
     * Observe the mount on exactly the expected native container. Fail if that is no longer
     * the selected service's container; never fall back to unbound observation.
     */
    readonly observeBoundVolume?: (
      target: ServiceSelector & { readonly expectedContainerId: string },
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
    readonly exportArtifact: (
      ref: ProviderArtifactRef,
    ) => Stream.Stream<Uint8Array, ProviderError, Scope.Scope>;
    readonly importArtifact: (
      data: Stream.Stream<Uint8Array, ProviderError>,
    ) => Effect.Effect<ProviderArtifactRef, ProviderError, Scope.Scope>;
  }
>()("@lando/core/RuntimeProvider") {}

export interface OwnedResourcesCleanupOptions {
  readonly volumes: boolean;
  /** Restrict ownership-inventory cleanup to these app identities at a shared root. */
  readonly appIds?: ReadonlyArray<AppId>;
  readonly purgeCaches?: boolean;
  /**
   * Retire the selected apps' shared global-cache members without inspecting or deleting the
   * volumes, which other apps keep using. Ignored when `purgeCaches` removes them instead.
   */
  readonly releaseCaches?: boolean;
}

export type RuntimeProviderShape = RuntimeProvider["Service"];
