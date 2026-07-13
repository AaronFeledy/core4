/** Effect service tags for the SDK. */
import type { Context, Effect, Option, Queue, Redacted, Schema, Scope, Stream } from "effect";

export type _ServiceTagCompatContext = typeof Context.Tag;

import type {
  AbsolutePath,
  AppPlan,
  DataEndpoint,
  DatasetApplyOptions,
  DatasetApplyResult,
  DatasetArtifactFormat,
  DatasetCapabilities,
  DatasetCaptureOptions,
  DatasetContext,
  DatasetKind,
  DeprecationNotice,
  DeprecationSurfaceKind,
  DeprecationUse,
  GlobalConfig,
  HostPlatform,
  HttpClientCapabilities,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpUploadRequest,
  LandofileShape,
  ManagedFile,
  ManagedFileInfo,
  ManagedFilePlan,
  ManagedFileResult,
  PluginManifest,
  PortablePath,
  PromptAnswer,
  PromptBatchOptions,
  PromptSpec,
  ProviderCapabilities,
  ProviderId,
  RecipeManifest,
  RemoteCapabilities,
  RemoteConfig,
  RemoteEnvId,
  RemoteEnvironment,
  RemoteFetchOptions,
  RemoteLocator,
  RemoteSendOptions,
  RemoteTestResult,
  ServiceConfig,
  ServiceCopyInSpec,
  ServiceCopyOutSpec,
  TunnelCapabilities,
  TunnelSession,
  TunnelSessionFilter,
  TunnelStartRequest,
  TunnelStatus,
  TunnelStatusRequest,
  TunnelStopRequest,
  VolumeFilter,
  VolumeInfo,
  VolumeRef,
  VolumeRestoreSpec,
  VolumeSnapshotRef,
  VolumeSnapshotSpec,
} from "../schema/index.ts";

import type {
  CacheError,
  CapabilityError,
  ConfigError,
  EventError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  HttpClientUnavailableError,
  HttpRequestError,
  HttpTrustError,
  HttpUploadError,
  LandofileFormConflictError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  LandofileVersionConstraintError,
  ManagedFileError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginLoadError,
  PluginManifestError,
  ProcessExecError,
  ProcessTimeoutError,
  ProviderConfigError,
  ProviderUnavailableError,
  RecipeManifestNotFoundError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
  SecretNotFoundError,
  ServiceTypeCollisionError,
  ShellExecError,
  ToolingExecError,
} from "../errors/index.ts";

import type { DeprecatedSurfaceError, DeprecationContradictionError } from "../errors/index.ts";

import type { AppFeatureDefinition } from "./app-features.ts";
import type { ToolingEngineResult, ToolingInvocation } from "./cli.ts";
import type { ConfigTranslatorShape } from "./config-translator.ts";
import type { DataMoverShape } from "./data-transfer.ts";
import type { DownloaderShape } from "./downloader.ts";
import type {
  EventFor,
  EventWaitAnyOptions,
  EventWaitOptions,
  EventWaitSpecs,
  LandoEvent,
} from "./events.ts";
import type { ServiceFeatureDefinition } from "./features.ts";
import type { FileSyncEngineShape } from "./file-sync.ts";
import type { FileStat, FileSystemError } from "./file-system.ts";
import type { GlobalAppPaths, GlobalDistResult } from "./global-app.ts";
import type { ConfirmSpec, InteractionError, PromptAnswers, SecretSpec, SelectSpec } from "./interaction.ts";
import type { ManagedFileApplyOptions, ManagedFileSelector } from "./managed-file.ts";
import type { LandoPaths } from "./paths.ts";
import type {
  CertificateAuthorityShape,
  HealthcheckRunnerShape,
  HostProxyServiceShape,
  ProxyServiceShape,
  SshServiceShape,
  UrlScannerShape,
} from "./platform.ts";
import type { PluginTrustState } from "./plugin-trust.ts";
import type { RegisteredCommand, ServiceType } from "./plugins.ts";
import type {
  ProcessResult,
  ProcessSpawnOptions,
  ProcessStreamChunk,
  ShellCommandOptions,
  ShellInteractiveResult,
  ShellInteractiveSpec,
} from "./process.ts";
import type {
  AppSelector,
  ApplyOptions,
  ApplyResult,
  ArtifactBuildSpec,
  ArtifactPullSpec,
  ArtifactRef,
  CommandSpec,
  DestroyOptions,
  EphemeralRunSpec,
  ExecChunk,
  ExecResult,
  ExecTarget,
  ListFilter,
  LogChunk,
  LogOptions,
  LogTarget,
  ProviderError,
  ProviderSetupOptions,
  ProviderStatus,
  ProviderVersions,
  ServiceRuntimeInfo,
  ServiceSelector,
} from "./provider.ts";
import type { DatasetServiceError, RemoteSourceError } from "./remote-sync.ts";
import type {
  ScratchAcquireInput,
  ScratchAppPaths,
  ScratchDestroyOptions,
  ScratchGcOptions,
  ScratchGcReport,
  ScratchHandle,
  ScratchInfo,
  ScratchStartOptions,
  ScratchSummary,
} from "./scratch.ts";
import type { StateStoreShape } from "./state-store.ts";
import type { TunnelError } from "./tunnel.ts";

export * from "./app-features.ts";
export * from "./cache.ts";
export * from "./cli.ts";
export * from "./config-translator.ts";
export * from "./config.ts";
export * from "./data-transfer.ts";
export * from "./deprecation.ts";
export * from "./downloader.ts";
export * from "./events.ts";
export * from "./features.ts";
export * from "./file-sync.ts";
export * from "./file-system.ts";
export * from "./global-app.ts";
export * from "./http-client.ts";
export * from "./interaction.ts";
export * from "./landofile.ts";
export * from "./managed-file.ts";
export * from "./paths.ts";
export * from "./planner.ts";
export * from "./platform.ts";
export * from "./plugins.ts";
export * from "./plugin-trust.ts";
export * from "./process.ts";
export * from "./provider.ts";
export * from "./recipe.ts";
export * from "./remote-sync.ts";
export * from "./scratch.ts";
export * from "./state-store.ts";
export * from "./tunnel.ts";
export type { AppId, ServiceInfo, ServiceName } from "../schema/index.ts";

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

export declare class ConfigService extends Context.Tag("@lando/core/ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<GlobalConfig, ConfigError>;
    readonly get: <K extends keyof GlobalConfig>(key: K) => Effect.Effect<GlobalConfig[K], ConfigError>;
  }
>() {}

export declare class LandofileService extends Context.Tag("@lando/core/LandofileService")<
  LandofileService,
  {
    readonly discover: Effect.Effect<
      LandofileShape,
      | LandofileNotFoundError
      | LandofileParseError
      | LandofileValidationError
      | LandofileSandboxError
      | LandofileTimeoutError
      | LandofileFormConflictError
      | LandofileIncludeError
      | LandofileLockMismatchError
      | NotImplementedError
    >;
  }
>() {}

export declare class GlobalAppService extends Context.Tag("@lando/core/GlobalAppService")<
  GlobalAppService,
  {
    readonly id: "global";
    readonly root: Effect.Effect<AbsolutePath, GlobalAppError>;
    readonly ensureRoot: Effect.Effect<void, GlobalAppError, Scope.Scope>;
    readonly paths: Effect.Effect<GlobalAppPaths, GlobalAppError>;
    readonly ensureUserLandofile: Effect.Effect<
      { readonly path: AbsolutePath; readonly created: boolean },
      GlobalAppError | GlobalLandofilePathConflictError
    >;
    readonly regenerateDist: (input?: { readonly services?: Record<string, ServiceConfig> }) => Effect.Effect<
      GlobalDistResult,
      GlobalAppError | GlobalDistConflictError
    >;
  }
>() {}

export declare class ScratchAppService extends Context.Tag("@lando/core/ScratchAppService")<
  ScratchAppService,
  {
    readonly kind: "scratch";
    readonly root: Effect.Effect<AbsolutePath, ScratchAppError>;
    readonly ensureRoot: Effect.Effect<AbsolutePath, ScratchAppError, Scope.Scope>;
    readonly synthesizeId: (base: string) => Effect.Effect<string, ScratchAppError>;
    readonly paths: (id: string) => Effect.Effect<ScratchAppPaths, ScratchAppError>;
    readonly acquire: (
      input: ScratchAcquireInput,
    ) => Effect.Effect<
      ScratchHandle,
      | ScratchSourceUnresolvedError
      | ScratchIsolationConflictError
      | ScratchAppError
      | LandofileVersionConstraintError,
      Scope.Scope
    >;
    readonly resolveById: (
      id: string,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly info: (id: string) => Effect.Effect<ScratchInfo, ScratchAppNotFoundError | ScratchAppError>;
    readonly list: () => Effect.Effect<ReadonlyArray<ScratchSummary>, ScratchAppError>;
    readonly start: (
      id: string,
      options?: ScratchStartOptions,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly stop: (id: string) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly destroy: (
      id: string,
      options?: ScratchDestroyOptions,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly gc: (options?: ScratchGcOptions) => Effect.Effect<ScratchGcReport, ScratchAppError>;
  }
>() {}

export declare class ManagedFileService extends Context.Tag("@lando/core/ManagedFileService")<
  ManagedFileService,
  {
    readonly plan: (files: ReadonlyArray<ManagedFile>) => Effect.Effect<ManagedFilePlan, ManagedFileError>;
    readonly apply: (
      files: ReadonlyArray<ManagedFile>,
      opts?: ManagedFileApplyOptions,
    ) => Effect.Effect<ManagedFileResult, ManagedFileError, Scope.Scope>;
    readonly remove: (selector: ManagedFileSelector) => Effect.Effect<ManagedFileResult, ManagedFileError>;
    readonly status: Effect.Effect<ReadonlyArray<ManagedFileInfo>, ManagedFileError>;
    readonly adopt: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
    readonly release: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
  }
>() {}

export declare class InteractionService extends Context.Tag("@lando/core/InteractionService")<
  InteractionService,
  {
    readonly id: string;
    readonly isInteractive: Effect.Effect<boolean>;
    readonly prompt: (spec: PromptSpec) => Effect.Effect<PromptAnswer, InteractionError, Scope.Scope>;
    readonly promptAll: (
      specs: ReadonlyArray<PromptSpec>,
      options?: PromptBatchOptions,
    ) => Effect.Effect<PromptAnswers, InteractionError, Scope.Scope>;
    readonly confirm: (spec: ConfirmSpec) => Effect.Effect<boolean, InteractionError, Scope.Scope>;
    readonly select: <A extends string | number | boolean>(
      spec: SelectSpec<A>,
    ) => Effect.Effect<A, InteractionError, Scope.Scope>;
    readonly secret: (
      spec: SecretSpec,
    ) => Effect.Effect<Redacted.Redacted<string>, InteractionError, Scope.Scope>;
  }
>() {}

export declare class RecipeManifestService extends Context.Tag("@lando/core/RecipeManifestService")<
  RecipeManifestService,
  {
    readonly parse: (
      source: string,
      content: string,
    ) => Effect.Effect<
      RecipeManifest,
      | RecipeManifestNotFoundError
      | RecipeManifestParseError
      | RecipeManifestValidationError
      | NotImplementedError
    >;
  }
>() {}

export declare class PluginRegistry extends Context.Tag("@lando/core/PluginRegistry")<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginManifest>, PluginManifestError>;
    readonly load: (name: string) => Effect.Effect<PluginManifest, PluginLoadError | PluginManifestError>;
    readonly loadServiceType: (
      id: string,
    ) => Effect.Effect<ServiceType, PluginLoadError | PluginManifestError | ServiceTypeCollisionError>;
    readonly loadServiceFeature: (
      id: string,
    ) => Effect.Effect<ServiceFeatureDefinition, PluginLoadError | PluginManifestError>;
    readonly loadAppFeature: (
      id: string,
    ) => Effect.Effect<AppFeatureDefinition, PluginLoadError | PluginManifestError>;
  }
>() {}

export declare class CommandRegistry extends Context.Tag("@lando/core/CommandRegistry")<
  CommandRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<RegisteredCommand>, never>;
  }
>() {}

export declare class PluginTrustStore extends Context.Tag("@lando/core/PluginTrustStore")<
  PluginTrustStore,
  {
    readonly read: Effect.Effect<PluginTrustState, ConfigError>;
    readonly isPluginTrusted: (name: string) => Effect.Effect<boolean, ConfigError>;
    readonly trustPlugin: (name: string) => Effect.Effect<void, ConfigError>;
    readonly untrustPlugin: (name: string) => Effect.Effect<void, ConfigError>;
    readonly isAuthoringRootTrusted: (path: string) => Effect.Effect<boolean, ConfigError>;
    readonly trustAuthoringRoot: (path: string) => Effect.Effect<void, ConfigError>;
  }
>() {}

export interface DeprecationSummaryEntry extends DeprecationUse {
  readonly count: number;
}

export declare class DeprecationService extends Context.Tag("@lando/core/DeprecationService")<
  DeprecationService,
  {
    readonly use: (use: DeprecationUse) => Effect.Effect<void, DeprecatedSurfaceError>;
    readonly summary: () => Effect.Effect<ReadonlyArray<DeprecationSummaryEntry>>;
    readonly lookup: (
      kind: DeprecationSurfaceKind,
      id: string,
    ) => Effect.Effect<Option.Option<DeprecationNotice>>;
    readonly register: (
      source: "core" | "plugin" | "schema-walk",
      kind: DeprecationSurfaceKind,
      id: string,
      notice: DeprecationNotice,
    ) => Effect.Effect<void>;
    readonly registerAlias: (
      source: "core" | "plugin" | "schema-walk",
      kind: DeprecationSurfaceKind,
      canonicalId: string,
      aliasId: string,
      aliasNotice?: DeprecationNotice,
    ) => Effect.Effect<void, DeprecationContradictionError>;
  }
>() {}

export declare class RuntimeProviderRegistry extends Context.Tag("@lando/core/RuntimeProviderRegistry")<
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

export declare class RuntimeProvider extends Context.Tag("@lando/core/RuntimeProvider")<
  RuntimeProvider,
  RuntimeProviderShape
>() {}

export declare class AppPlanner extends Context.Tag("@lando/core/AppPlanner")<
  AppPlanner,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
    ) => Effect.Effect<AppPlan, LandofileValidationError | CapabilityError | NotImplementedError>;
  }
>() {}

export declare class BuildOrchestrator extends Context.Tag("@lando/core/BuildOrchestrator")<
  BuildOrchestrator,
  {
    readonly build: (
      plan: AppPlan,
    ) => Effect.Effect<
      AppPlan,
      EventError | NoProviderInstalledError | ProviderConfigError | ProviderError | ProviderUnavailableError
    >;
  }
>() {}

export declare class EventService extends Context.Tag("@lando/core/EventService")<
  EventService,
  {
    readonly publish: (event: LandoEvent) => Effect.Effect<void, EventError>;
    readonly subscribe: <Name extends string>(name: Name) => Stream.Stream<EventFor<Name>, EventError>;
    readonly subscribeQueue: Effect.Effect<Queue.Dequeue<LandoEvent>, never, Scope.Scope>;
    readonly waitFor: <Name extends string>(
      name: Name,
      options?: EventWaitOptions<Name>,
    ) => Effect.Effect<EventFor<Name>, EventError>;
    readonly waitForAny: <const Names extends readonly string[]>(
      specs: EventWaitSpecs<Names>,
      options?: EventWaitAnyOptions,
    ) => Effect.Effect<EventFor<Names[number] & string>, EventError>;
    readonly query: <Name extends string>(
      name: Name,
      filter?: (event: EventFor<Name>) => boolean,
    ) => Effect.Effect<ReadonlyArray<EventFor<Name>>, never>;
  }
>() {}

export declare class CacheService extends Context.Tag("@lando/core/CacheService")<
  CacheService,
  {
    readonly read: <A, I>(key: string, schema?: Schema.Schema<A, I>) => Effect.Effect<A | null, CacheError>;
    readonly write: <A>(key: string, value: A, ttlMs?: number) => Effect.Effect<void, CacheError>;
    readonly writeAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, CacheError>;
    readonly invalidate: (key: string) => Effect.Effect<void, CacheError>;
  }
>() {}

export declare class FileSystem extends Context.Tag("@lando/core/FileSystem")<
  FileSystem,
  {
    readonly read: (path: string) => Stream.Stream<Uint8Array, FileSystemError>;
    readonly readText: (path: string) => Effect.Effect<string, FileSystemError>;
    readonly write: (path: string, content: string | Uint8Array) => Effect.Effect<void, FileSystemError>;
    readonly writeAtomic: (
      path: string,
      content: string | Uint8Array,
    ) => Effect.Effect<void, FileSystemError>;
    readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>;
    readonly stat: (path: string) => Effect.Effect<FileStat, FileSystemError>;
    readonly lstat: (path: string) => Effect.Effect<FileStat, FileSystemError>;
    readonly mkdir: (path: string) => Effect.Effect<void, FileSystemError>;
    readonly remove: (path: string) => Effect.Effect<void, FileSystemError>;
    readonly readDir: (path: string) => Effect.Effect<ReadonlyArray<string>, FileSystemError>;
    readonly readFile: (path: string) => Effect.Effect<string, FileSystemError>;
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, FileSystemError>;
  }
>() {}

export declare class ProcessRunner extends Context.Tag("@lando/core/ProcessRunner")<
  ProcessRunner,
  {
    readonly run: (
      options: ProcessSpawnOptions,
    ) => Effect.Effect<ProcessResult, ProcessExecError | ProcessTimeoutError>;
    readonly stream: (
      options: ProcessSpawnOptions,
    ) => Stream.Stream<ProcessStreamChunk, ProcessExecError | ProcessTimeoutError>;
  }
>() {}

export declare class ShellRunner extends Context.Tag("@lando/core/ShellRunner")<
  ShellRunner,
  {
    readonly exec: (
      command: string,
      options?: ShellCommandOptions,
    ) => Effect.Effect<ProcessResult, ShellExecError>;
    readonly run: (
      command: string,
      options?: ShellCommandOptions,
    ) => Effect.Effect<ProcessResult, ShellExecError>;
    readonly runScript: (
      path: string,
      options?: ShellCommandOptions,
    ) => Effect.Effect<ProcessResult, ShellExecError>;
    readonly interactive: (
      spec: ShellInteractiveSpec,
    ) => Effect.Effect<ShellInteractiveResult, ShellExecError>;
  }
>() {}

export declare class PrivilegeService extends Context.Tag("@lando/core/PrivilegeService")<
  PrivilegeService,
  {
    readonly elevate: (command: ReadonlyArray<string>) => Effect.Effect<ProcessResult, never>;
  }
>() {}

export declare class Logger extends Context.Tag("@lando/core/Logger")<
  Logger,
  {
    readonly debug: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
    readonly info: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
    readonly warn: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
    readonly error: (
      message: string,
      data?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, EventError>;
  }
>() {}

export declare class Renderer extends Context.Tag("@lando/core/Renderer")<
  Renderer,
  {
    readonly id: string;
    readonly message: {
      readonly info: (body: string) => Effect.Effect<void, EventError>;
      readonly warn: (body: string) => Effect.Effect<void, EventError>;
      readonly error: (body: string, remediation?: string) => Effect.Effect<void, EventError>;
    };
    readonly output: {
      readonly stdout: (chunk: string) => Effect.Effect<void>;
      readonly stderr: (chunk: string) => Effect.Effect<void>;
    };
  }
>() {}

export declare class Telemetry extends Context.Tag("@lando/core/Telemetry")<
  Telemetry,
  {
    readonly enabled: boolean;
    readonly record: (event: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, never>;
  }
>() {}

export declare class ToolingEngine extends Context.Tag("@lando/core/ToolingEngine")<
  ToolingEngine,
  {
    readonly id: string;
    readonly run: (
      invocation: ToolingInvocation,
      plan: AppPlan,
      provider: RuntimeProviderShape,
    ) => Effect.Effect<ToolingEngineResult, ProviderError | ToolingExecError>;
  }
>() {}

export declare class SchemaValidator extends Context.Tag("@lando/core/SchemaValidator")<
  SchemaValidator,
  {
    readonly id: string;
  }
>() {}

export declare class CommandFramework extends Context.Tag("@lando/core/CommandFramework")<
  CommandFramework,
  {
    readonly id: string;
  }
>() {}

export declare class CertificateAuthority extends Context.Tag("@lando/core/CertificateAuthority")<
  CertificateAuthority,
  CertificateAuthorityShape
>() {}

export declare class ProxyService extends Context.Tag("@lando/core/ProxyService")<
  ProxyService,
  ProxyServiceShape
>() {}

export declare class SshService extends Context.Tag("@lando/core/SshService")<
  SshService,
  SshServiceShape
>() {}

export declare class HealthcheckRunner extends Context.Tag("@lando/core/HealthcheckRunner")<
  HealthcheckRunner,
  HealthcheckRunnerShape
>() {}

export declare class UrlScanner extends Context.Tag("@lando/core/UrlScanner")<
  UrlScanner,
  UrlScannerShape
>() {}

export declare class HostProxyService extends Context.Tag("@lando/core/HostProxyService")<
  HostProxyService,
  HostProxyServiceShape
>() {}

export declare class PluginSource extends Context.Tag("@lando/core/PluginSource")<
  PluginSource,
  {
    readonly id: string;
  }
>() {}

export declare class UpdateService extends Context.Tag("@lando/core/UpdateService")<
  UpdateService,
  {
    readonly id: string;
  }
>() {}

export declare class SecretStore extends Context.Tag("@lando/core/SecretStore")<
  SecretStore,
  {
    readonly id: string;
    readonly get: (secret: string) => Effect.Effect<string, SecretNotFoundError>;
    readonly has: (secret: string) => Effect.Effect<boolean>;
    readonly list: Effect.Effect<ReadonlyArray<string>>;
  }
>() {}

export declare class FileSyncEngine extends Context.Tag("@lando/core/FileSyncEngine")<
  FileSyncEngine,
  FileSyncEngineShape
>() {}

export declare class Downloader extends Context.Tag("@lando/core/Downloader")<
  Downloader,
  DownloaderShape
>() {}

export declare class HttpClient extends Context.Tag("@lando/core/HttpClient")<
  HttpClient,
  {
    readonly id: string;
    readonly capabilities: HttpClientCapabilities;
    readonly request: (
      req: HttpRequest,
    ) => Effect.Effect<
      HttpResponse,
      HttpRequestError | HttpTrustError | HttpClientUnavailableError,
      Scope.Scope
    >;
    readonly stream: (req: HttpRequest) => Effect.Effect<
      HttpStreamResponse & {
        readonly body: Stream.Stream<Uint8Array, HttpRequestError | HttpTrustError>;
      },
      HttpRequestError | HttpTrustError | HttpClientUnavailableError,
      Scope.Scope
    >;
    readonly upload: (
      req: HttpUploadRequest,
    ) => Effect.Effect<
      HttpResponse,
      HttpUploadError | HttpTrustError | HttpClientUnavailableError,
      Scope.Scope
    >;
  }
>() {}

export declare class DataMover extends Context.Tag("@lando/core/DataMover")<DataMover, DataMoverShape>() {}

export declare class PathsService extends Context.Tag("@lando/core/PathsService")<
  PathsService,
  LandoPaths
>() {}

export declare class StateStore extends Context.Tag("@lando/core/StateStore")<
  StateStore,
  StateStoreShape
>() {}

export declare class RemoteSource extends Context.Tag("@lando/core/RemoteSource")<
  RemoteSource,
  {
    readonly id: string;
    readonly capabilities: RemoteCapabilities;
    readonly configSchema: Schema.Schema<unknown>;
    readonly listEnvironments: (
      cfg: RemoteConfig,
    ) => Effect.Effect<ReadonlyArray<RemoteEnvironment>, RemoteSourceError>;
    readonly resolve: (
      cfg: RemoteConfig,
      env: RemoteEnvId,
      datasetId: string,
    ) => Effect.Effect<RemoteLocator, RemoteSourceError>;
    readonly fetch: (
      locator: RemoteLocator,
      opts?: RemoteFetchOptions,
    ) => Effect.Effect<DataEndpoint, RemoteSourceError, Scope.Scope>;
    readonly send: (
      locator: RemoteLocator,
      artifact: DataEndpoint,
      opts?: RemoteSendOptions,
    ) => Effect.Effect<void, RemoteSourceError, Scope.Scope>;
    readonly test?: (
      cfg: RemoteConfig,
      env?: RemoteEnvId,
    ) => Effect.Effect<RemoteTestResult, RemoteSourceError>;
  }
>() {}

export declare class Dataset extends Context.Tag("@lando/core/Dataset")<
  Dataset,
  {
    readonly id: string;
    readonly kind: DatasetKind;
    readonly capabilities: DatasetCapabilities;
    readonly artifactFormat: DatasetArtifactFormat;
    readonly capture: (
      ctx: DatasetContext,
      opts?: DatasetCaptureOptions,
    ) => Effect.Effect<DataEndpoint, DatasetServiceError, Scope.Scope>;
    readonly apply: (
      ctx: DatasetContext,
      artifact: DataEndpoint,
      opts?: DatasetApplyOptions,
    ) => Effect.Effect<DatasetApplyResult, DatasetServiceError, Scope.Scope>;
    readonly localStore: (ctx: DatasetContext) => Effect.Effect<VolumeRef | null, DatasetServiceError>;
  }
>() {}

export declare class TunnelService extends Context.Tag("@lando/core/TunnelService")<
  TunnelService,
  {
    readonly id: string;
    readonly capabilities: TunnelCapabilities;
    readonly start: (request: TunnelStartRequest) => Effect.Effect<TunnelSession, TunnelError, Scope.Scope>;
    readonly stop: (request: TunnelStopRequest) => Effect.Effect<void, TunnelError>;
    readonly status: (request: TunnelStatusRequest) => Effect.Effect<TunnelStatus, TunnelError>;
    readonly list: (filter?: TunnelSessionFilter) => Effect.Effect<ReadonlyArray<TunnelSession>, TunnelError>;
  }
>() {}

export declare class ConfigTranslator extends Context.Tag("@lando/core/ConfigTranslator")<
  ConfigTranslator,
  ConfigTranslatorShape
>() {}
