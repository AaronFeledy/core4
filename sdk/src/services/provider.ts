import { Context, type Effect, type Scope, type Stream } from "effect";

import type {
  ArtifactTransferError,
  NoProviderInstalledError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceCopyError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
  VolumeOperationError,
} from "../errors/index.ts";
import type {
  AppId,
  AppPlan,
  DataStoreMountPlan,
  EndpointPlan,
  HostPlatform,
  MountPlan,
  NetworkConfig,
  ProviderCapabilities,
  ProviderId,
  ServiceCopyInSpec,
  ServiceCopyOutSpec,
  ServiceName,
  VolumeFilter,
  VolumeInfo,
  VolumeRef,
  VolumeRestoreSpec,
  VolumeSnapshotRef,
  VolumeSnapshotSpec,
} from "../schema/index.ts";
import type { PrivilegeService } from "./process.ts";

export type ProviderError =
  | ProviderCapabilityError
  | ProviderConfigError
  | ProviderInternalError
  | ProviderUnavailableError
  | ServiceExecError
  | ServiceNotFoundError
  | ServiceStartError
  | VolumeOperationError
  | ServiceCopyError
  | ArtifactTransferError;

export interface ProviderSetupOptions {
  readonly force: boolean;
  readonly runtimeBundleUrl?: string;
  readonly runtimeBundleSha256?: string;
  readonly network?: NetworkConfig;
  readonly privilege?: Context.Tag.Service<typeof PrivilegeService>;
  /** Parsed values of the setup flags this provider's plugin contributed via `setup.flags`. */
  readonly setupFlags?: Readonly<Record<string, unknown>>;
}

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
  readonly signal?: AbortSignal;
}

export interface ApplyResult {
  readonly changed: boolean;
}

export interface ServiceSelector {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly plan?: AppPlan;
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
}

export interface LogChunk {
  readonly service: ServiceName;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
  readonly timestamp?: Date;
}

export interface ServiceRuntimeInfo {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly providerId: ProviderId;
  readonly status: string;
  readonly state?: string;
  readonly containerId?: string;
  readonly endpoints?: ReadonlyArray<EndpointPlan>;
  readonly lastStartedAt?: Date;
}

export interface ListFilter {
  readonly app?: AppId;
}

export class RuntimeProviderRegistry extends Context.Tag("@lando/core/RuntimeProviderRegistry")<
  RuntimeProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderId>, ProviderUnavailableError>;
    readonly capabilities: Effect.Effect<
      ProviderCapabilities,
      ProviderUnavailableError | ProviderConfigError | NoProviderInstalledError
    >;
    readonly select: (
      plan?: AppPlan,
    ) => Effect.Effect<
      RuntimeProviderShape,
      ProviderUnavailableError | ProviderConfigError | NoProviderInstalledError
    >;
  }
>() {}

export interface RuntimeProviderShape {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly platform: HostPlatform;
  readonly capabilities: ProviderCapabilities;

  readonly isAvailable: Effect.Effect<boolean, ProviderUnavailableError>;
  readonly setup: (options: ProviderSetupOptions) => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly getStatus: Effect.Effect<ProviderStatus, ProviderError>;
  readonly getVersions: Effect.Effect<ProviderVersions, ProviderError>;

  readonly buildArtifact: (spec: ArtifactBuildSpec) => Effect.Effect<ArtifactRef, ProviderError, Scope.Scope>;
  readonly pullArtifact: (spec: ArtifactPullSpec) => Effect.Effect<ArtifactRef, ProviderError>;
  readonly removeArtifact: (ref: ArtifactRef) => Effect.Effect<void, ProviderError>;

  readonly apply: (
    plan: AppPlan,
    options: ApplyOptions,
  ) => Effect.Effect<ApplyResult, ProviderError, Scope.Scope>;
  readonly start: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly stop: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly restart: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly destroy: (target: AppSelector, options: DestroyOptions) => Effect.Effect<void, ProviderError>;

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
  readonly removeVolume: (ref: VolumeRef) => Effect.Effect<void, ProviderError>;
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

export class RuntimeProvider extends Context.Tag("@lando/core/RuntimeProvider")<
  RuntimeProvider,
  RuntimeProviderShape
>() {}
