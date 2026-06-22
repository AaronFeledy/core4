/** Effect service tags for the SDK. */
import type { Context, Effect, Option, Queue, Schema, Scope, Stream } from "effect";

type _ServiceTagCompatContext = typeof Context.Tag;

import type {
  AbsolutePath,
  AppPlan,
  DeprecationNotice,
  DeprecationSurfaceKind,
  DeprecationUse,
  GlobalConfig,
  HostPlatform,
  LandofileShape,
  ManagedFile,
  ManagedFileInfo,
  ManagedFilePlan,
  ManagedFileResult,
  PluginManifest,
  PortablePath,
  ProviderCapabilities,
  ProviderId,
  RecipeManifest,
  ServiceConfig,
} from "../schema/index.ts";

import type {
  CacheError,
  CapabilityError,
  ConfigError,
  EventError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
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
  ShellExecError,
  ToolingExecError,
} from "../errors/index.ts";

import type { DeprecatedSurfaceError, DeprecationContradictionError } from "../errors/index.ts";

import type { ToolingEngineResult, ToolingInvocation } from "./cli.ts";
import type { ConfigTranslatorShape } from "./config-translator.ts";
import type { DataMoverShape } from "./data-transfer.ts";
import type { DownloaderShape } from "./downloader.ts";
import type { LandoEvent } from "./events.ts";
import type { FileSyncEngineShape } from "./file-sync.ts";
import type { FileStat, FileSystemError } from "./file-system.ts";
import type { GlobalAppPaths, GlobalDistResult } from "./global-app.ts";
import type { ManagedFileApplyOptions, ManagedFileSelector } from "./managed-file.ts";
import type {
  CertificateAuthorityShape,
  HealthcheckRunnerShape,
  HostProxyServiceShape,
  ProxyServiceShape,
  SshServiceShape,
  UrlScannerShape,
} from "./platform.ts";
import type { PluginTrustState } from "./plugin-trust.ts";
import type { RegisteredCommand, ServiceTypeShape } from "./plugins.ts";
import type {
  ProcessResult,
  ProcessSpawnOptions,
  ProcessStreamChunk,
  ShellCommandOptions,
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

export * from "./cache.ts";
export * from "./cli.ts";
export * from "./config-translator.ts";
export * from "./config.ts";
export * from "./data-transfer.ts";
export * from "./deprecation.ts";
export * from "./downloader.ts";
export * from "./events.ts";
export * from "./file-sync.ts";
export * from "./file-system.ts";
export * from "./global-app.ts";
export * from "./landofile.ts";
export * from "./managed-file.ts";
export * from "./planner.ts";
export * from "./platform.ts";
export * from "./plugins.ts";
export * from "./plugin-trust.ts";
export * from "./process.ts";
export * from "./provider.ts";
export * from "./recipe.ts";
export * from "./scratch.ts";
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
  readonly logs: (target: LogTarget, options: LogOptions) => Stream.Stream<LogChunk, ProviderError>;
  readonly inspect: (target: ServiceSelector) => Effect.Effect<ServiceRuntimeInfo, ProviderError>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<ServiceRuntimeInfo>, ProviderError>;
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
      ScratchSourceUnresolvedError | ScratchIsolationConflictError | ScratchAppError,
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
    ) => Effect.Effect<ServiceTypeShape, PluginLoadError | PluginManifestError>;
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
      void,
      EventError | NoProviderInstalledError | ProviderConfigError | ProviderError | ProviderUnavailableError
    >;
  }
>() {}

export declare class EventService extends Context.Tag("@lando/core/EventService")<
  EventService,
  {
    readonly publish: (event: LandoEvent) => Effect.Effect<void, EventError>;
    readonly subscribe: (name: string) => Stream.Stream<LandoEvent, EventError>;
    /**
     * Eagerly acquires a `PubSub` subscription queue in the caller's `Scope`
     * so consumers that need the first event must use it instead of the lazy
     * `subscribe` stream.
     */
    readonly subscribeQueue: Effect.Effect<Queue.Dequeue<LandoEvent>, never, Scope.Scope>;
    readonly waitFor: (
      name: string,
      filter?: (event: LandoEvent) => boolean,
    ) => Effect.Effect<LandoEvent, EventError>;
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

export declare class DataMover extends Context.Tag("@lando/core/DataMover")<DataMover, DataMoverShape>() {}

export declare class ConfigTranslator extends Context.Tag("@lando/core/ConfigTranslator")<
  ConfigTranslator,
  ConfigTranslatorShape
>() {}
