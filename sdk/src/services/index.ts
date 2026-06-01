/** Effect service tags for the SDK. */
import { Context, type Effect, type Queue, type Schema, type Scope, type Stream } from "effect";

import type {
  AbsolutePath,
  AppId,
  AppPlan,
  AppRef,
  EndpointPlan,
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionFilter,
  FileSyncSessionInfo,
  FileSyncSessionRef,
  FileSyncSessionSpec,
  FileSyncSetupOptions,
  GlobalConfig,
  HealthcheckPlan,
  HostPlatform,
  IsolateMode,
  LandofileShape,
  PlanMetadata,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  RecipeManifest,
  RoutePlan,
  ServiceConfig,
  ServiceInfo,
  ServiceName,
  ServicePlan,
} from "../schema/index.ts";

import type {
  CaError,
  CacheError,
  CapabilityError,
  ConfigError,
  EventError,
  FileIoError,
  FileNotFoundError,
  FilePermissionError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  HealthcheckError,
  HealthcheckTimeoutError,
  HostProxyError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginLoadError,
  PluginManifestError,
  PortCollisionError,
  ProcessExecError,
  ProcessTimeoutError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderUnavailableError,
  ProxyError,
  RecipeManifestNotFoundError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
  ScannerError,
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
  ShellExecError,
  SshError,
  ToolingExecError,
} from "../errors/index.ts";

export type ProviderError =
  | ProviderCapabilityError
  | ProviderConfigError
  | ProviderInternalError
  | ProviderUnavailableError
  | ServiceExecError
  | ServiceNotFoundError
  | ServiceStartError;

export type FileSyncError = FileSyncStartError | FileSyncDriftError | FileSyncStopError;

export type FileSystemError = FileNotFoundError | FilePermissionError | FileIoError;

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink?: boolean;
}

export interface ProviderSetupOptions {
  readonly force: boolean;
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
}

export interface LogTarget extends ServiceSelector {}

export interface LogOptions {
  readonly follow: boolean;
  readonly tail?: number;
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

export interface ShellCommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: "bun";
}

export class ConfigService extends Context.Tag("@lando/core/ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<GlobalConfig, ConfigError>;
    readonly get: <K extends keyof GlobalConfig>(key: K) => Effect.Effect<GlobalConfig[K], ConfigError>;
  }
>() {}

export class LandofileService extends Context.Tag("@lando/core/LandofileService")<
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

export interface GlobalAppPaths {
  readonly root: AbsolutePath;
  readonly distLandofile: AbsolutePath;
  readonly userLandofile: AbsolutePath;
}

export interface GlobalDistResult {
  readonly path: AbsolutePath;
  readonly status: "created" | "updated" | "unchanged";
  readonly serviceIds: ReadonlyArray<string>;
}

export class GlobalAppService extends Context.Tag("@lando/core/GlobalAppService")<
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

export interface ScratchAppPaths {
  readonly base: AbsolutePath;
  readonly instanceRoot: AbsolutePath;
  readonly root: AbsolutePath;
  readonly planCache: AbsolutePath;
  readonly infoCache: AbsolutePath;
  readonly buildResults: AbsolutePath;
}

export type ScratchSource = { readonly kind: "fork" } | { readonly kind: "recipe"; readonly ref: string };

/**
 * Opt-in to mounting the host current working directory ($PWD) into the
 * scratch app's primary service. Presence of this object enables the mount;
 * `target` overrides the container mount point (defaults to the primary
 * service's appMount destination, or `/app`).
 */
export interface ScratchMountCwd {
  readonly target?: string;
}

export interface ScratchAcquireInput {
  readonly source: ScratchSource;
  readonly detached: boolean;
  readonly name?: string;
  readonly answers?: Record<string, string>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly isolate?: IsolateMode;
  /** Mount $PWD into the scratch app's primary service (`--mount-cwd`). */
  readonly mountCwd?: ScratchMountCwd;
  /**
   * Join the shared cross-app network and expose the global app's storage
   * scope (`--share-global-storage`). Explicit opt-in; never inferred.
   */
  readonly shareGlobalStorage?: boolean;
}

export interface ScratchHandle {
  readonly id: string;
  readonly app: AppRef;
}

/**
 * Lifetime status of a scratch app, derived from its registry entry:
 * - `attached`  — a foreground scratch whose owning CLI process is still alive.
 * - `detached`  — a `--detach` scratch that outlives the command that created it.
 * - `orphan`    — a foreground scratch whose owning process exited without
 *                 cleaning up (a reap candidate for `apps:scratch:gc`).
 */
export type ScratchLifetimeStatus = "attached" | "detached" | "orphan";

export interface ScratchSummary {
  readonly id: string;
  readonly app: AppRef;
  /** Where the scratch app came from — a fork of the cwd app or a recipe. */
  readonly source: ScratchSource;
  /** Isolation mode the scratch app was started in (`none` | `full`). */
  readonly mode: IsolateMode;
  /** ISO 8601 timestamp the scratch app was first registered. */
  readonly created: string;
  /** Lifetime status (`attached` | `detached` | `orphan`). */
  readonly status: ScratchLifetimeStatus;
}

/** A single mount surfaced by `apps:scratch:info`. */
export interface ScratchMountPoint {
  /** Service the mount is attached to. */
  readonly service: string;
  /** Container mount point. */
  readonly target: string;
  /** Host path or volume name (omitted for `tmpfs`). */
  readonly source?: string;
  /** Mount kind: the app mount, a generic bind/volume/tmpfs mount. */
  readonly kind: "app" | "bind" | "tmpfs" | "volume";
  /** Whether the mount is read-only. */
  readonly readOnly: boolean;
}

/** Network membership surfaced by `apps:scratch:info`. */
export interface ScratchNetworkMembership {
  /** Per-app bridge network name (when planned). */
  readonly perAppBridge?: string;
  /** Shared cross-app network name (present only when joined). */
  readonly sharedNetwork?: string;
}

/** Per-service endpoint listing surfaced by `apps:scratch:info`. */
export interface ScratchServiceEndpoints {
  readonly service: string;
  readonly endpoints: ReadonlyArray<{
    readonly protocol: string;
    readonly port?: number;
    readonly name?: string;
  }>;
}

/**
 * Full inspection of a single scratch app: the same fields as a
 * `ScratchSummary` plus the realized mount points, network membership, and
 * per-service endpoints read from the cached plan.
 */
export interface ScratchInfo extends ScratchSummary {
  readonly mounts: ReadonlyArray<ScratchMountPoint>;
  readonly network: ScratchNetworkMembership;
  readonly endpoints: ReadonlyArray<ScratchServiceEndpoints>;
}

export interface ScratchStartOptions {
  readonly detach?: boolean;
}

export interface ScratchDestroyOptions {
  readonly keepVolumes?: boolean;
}

export interface ScratchGcOptions {
  readonly prune?: boolean;
}

export interface ScratchGcReport {
  readonly inspected: number;
  readonly reaped: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export class ScratchAppService extends Context.Tag("@lando/core/ScratchAppService")<
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

export class RecipeManifestService extends Context.Tag("@lando/core/RecipeManifestService")<
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

export class PluginRegistry extends Context.Tag("@lando/core/PluginRegistry")<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginManifest>, PluginManifestError>;
    readonly load: (name: string) => Effect.Effect<PluginManifest, PluginLoadError | PluginManifestError>;
    readonly loadServiceType: (
      id: string,
    ) => Effect.Effect<ServiceTypeShape, PluginLoadError | PluginManifestError>;
  }
>() {}

export interface ServiceTypeHostFacts {
  readonly os: string;
  readonly user: string;
  readonly uid: string;
  readonly gid: string;
  readonly home: string;
}

export interface ServiceTypePlanInput {
  readonly name: string;
  readonly service: ServiceConfig;
  readonly appRoot: string;
  readonly appName?: string;
  readonly provider?: ProviderId;
  readonly primary?: boolean;
  readonly metadata: typeof PlanMetadata.Encoded;
  readonly host?: ServiceTypeHostFacts | undefined;
}

export interface ServiceTypeShape {
  readonly id: string;
  readonly toServicePlan: (input: ServiceTypePlanInput) => ServicePlan;
}

export interface RegisteredCommand {
  readonly id: string;
  readonly summary: string;
  readonly hidden: boolean;
}

export class CommandRegistry extends Context.Tag("@lando/core/CommandRegistry")<
  CommandRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<RegisteredCommand>, never>;
  }
>() {}

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
  readonly logs: (target: LogTarget, options: LogOptions) => Stream.Stream<LogChunk, ProviderError>;
  readonly inspect: (target: ServiceSelector) => Effect.Effect<ServiceRuntimeInfo, ProviderError>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<ServiceRuntimeInfo>, ProviderError>;
}

export interface DestroyOptions {
  readonly volumes: boolean;
  readonly removeState?: boolean;
}

export class RuntimeProvider extends Context.Tag("@lando/core/RuntimeProvider")<
  RuntimeProvider,
  RuntimeProviderShape
>() {}

export class AppPlanner extends Context.Tag("@lando/core/AppPlanner")<
  AppPlanner,
  {
    readonly plan: (
      landofile: LandofileShape,
      providerCapabilities: ProviderCapabilities,
    ) => Effect.Effect<AppPlan, LandofileValidationError | CapabilityError | NotImplementedError>;
  }
>() {}

export class BuildOrchestrator extends Context.Tag("@lando/core/BuildOrchestrator")<
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

export interface LandoEvent {
  readonly _tag: string;
  readonly [key: string]: unknown;
}

export class EventService extends Context.Tag("@lando/core/EventService")<
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

export class CacheService extends Context.Tag("@lando/core/CacheService")<
  CacheService,
  {
    readonly read: <A, I>(key: string, schema?: Schema.Schema<A, I>) => Effect.Effect<A | null, CacheError>;
    readonly write: <A>(key: string, value: A, ttlMs?: number) => Effect.Effect<void, CacheError>;
    readonly writeAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, CacheError>;
    readonly invalidate: (key: string) => Effect.Effect<void, CacheError>;
  }
>() {}

export class FileSystem extends Context.Tag("@lando/core/FileSystem")<
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

export interface ProcessSpawnOptions {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessStreamChunk {
  readonly kind: "stdout" | "stderr";
  readonly chunk: Uint8Array;
}

export class ProcessRunner extends Context.Tag("@lando/core/ProcessRunner")<
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

export class ShellRunner extends Context.Tag("@lando/core/ShellRunner")<
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

export class PrivilegeService extends Context.Tag("@lando/core/PrivilegeService")<
  PrivilegeService,
  {
    readonly elevate: (command: ReadonlyArray<string>) => Effect.Effect<ProcessResult, never>;
  }
>() {}

/**
 * Logger — structured logging through Effect.
 *
 * Replaceable; default is Effect's Logger.pretty (TTY) / Logger.json (non-TTY).
 *
 * Note: the actual Effect logger contract is `Logger.Logger<Message, Output>`.
 * This tag is the *Lando* logger service — a thin wrapper that selects which
 * Effect Logger configuration to install.
 */
export class Logger extends Context.Tag("@lando/core/Logger")<
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

/**
 * Renderer — CLI output strategy.
 */
export class Renderer extends Context.Tag("@lando/core/Renderer")<
  Renderer,
  {
    readonly id: string;
  }
>() {}

/**
 * Telemetry — optional usage stats. Off by default in CLI mode; off by
 * default in library mode.
 */
export class Telemetry extends Context.Tag("@lando/core/Telemetry")<
  Telemetry,
  {
    readonly enabled: boolean;
    readonly record: (event: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, never>;
  }
>() {}

/**
 * A normalized tooling invocation passed to a `ToolingEngine`.
 *
 * The compiler converts a parsed Landofile `tooling.<name>` task plus any
 * pass-through CLI args into one or more provider exec calls. The engine
 * does not see `cmd:` / `cmds:` / shell-wrapping rules directly — only the
 * argv form it should hand to `RuntimeProvider.exec` (or its host
 * equivalent). The order of `commands` is significant; engines execute
 * them sequentially and stop at the first non-zero exit code.
 */
export interface ToolingInvocation {
  /** Tooling task name (the Landofile `tooling.<name>` key). */
  readonly tool: string;
  /** Optional declared service from the task; falls back to primary. */
  readonly service?: string;
  /** Optional unix user to execute as. */
  readonly user?: string;
  /** Optional working directory inside the service. */
  readonly cwd?: string;
  /** Optional environment overlay applied to every command. */
  readonly env?: Readonly<Record<string, string>>;
  /** Pre-normalized argv forms, executed in order. */
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Result of executing a tooling invocation: the exit code of the last
 * command that ran plus the aggregated stdout/stderr captured across all
 * commands.
 */
export interface ToolingEngineResult {
  readonly tool: string;
  readonly service: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * ToolingEngine — translate a tooling invocation into a sequence of provider
 * operations. Default: `providerExec`.
 *
 * Selection precedence: `tooling.<name>.engine` → Landofile-level
 * `toolingEngine` → global config `toolingEngine` → default `providerExec`.
 *
 * Engines receive a fully-normalized invocation (argv form, resolved service
 * name still authored as the task `service:` value, etc.) and an `AppPlan`
 * for any plan-level data they need (primary-service lookup, provider id).
 */
export class ToolingEngine extends Context.Tag("@lando/core/ToolingEngine")<
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

/**
 * SchemaValidator — validate Landofile/manifest data. Default: Effect Schema.
 */
export class SchemaValidator extends Context.Tag("@lando/core/SchemaValidator")<
  SchemaValidator,
  {
    readonly id: string;
  }
>() {}

/**
 * CommandFramework — argv parsing, manifest, help, plugin install commands.
 *
 * Default: OCLIF. Replaceable but not recommended.
 */
export class CommandFramework extends Context.Tag("@lando/core/CommandFramework")<
  CommandFramework,
  {
    readonly id: string;
  }
>() {}

export interface CaSetupOptions {
  readonly force: boolean;
  readonly skipTrustInstall?: boolean;
}

export interface CertificateSpec {
  readonly cn: string;
  readonly sans: ReadonlyArray<string>;
}

export interface CertificateResult {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath: string;
}

export interface CertificateAuthorityShape {
  readonly id: string;
  readonly setup: (options: CaSetupOptions) => Effect.Effect<void, CaError>;
  readonly issueCert: (spec: CertificateSpec) => Effect.Effect<CertificateResult, CaError>;
}

export class CertificateAuthority extends Context.Tag("@lando/core/CertificateAuthority")<
  CertificateAuthority,
  CertificateAuthorityShape
>() {}

export interface ProxyServiceShape {
  readonly id: string;
  readonly setup: () => Effect.Effect<void, ProxyError>;
  readonly applyRoutes: (routes: ReadonlyArray<RoutePlan>, appId: AppId) => Effect.Effect<void, ProxyError>;
  readonly removeRoutes: (appId: AppId) => Effect.Effect<void, ProxyError>;
}

export class ProxyService extends Context.Tag("@lando/core/ProxyService")<
  ProxyService,
  ProxyServiceShape
>() {}

export interface SshSetupOptions {
  readonly force: boolean;
}

export interface SshAgentSocket {
  readonly socketPath: string;
  readonly appId: AppId;
}

export interface SshServiceShape {
  readonly id: string;
  readonly setup: (options: SshSetupOptions) => Effect.Effect<void, SshError>;
  readonly getAgentSocket: (appId: AppId) => Effect.Effect<SshAgentSocket, SshError>;
}

export class SshService extends Context.Tag("@lando/core/SshService")<SshService, SshServiceShape>() {}

export interface HealthcheckResult {
  readonly healthy: boolean;
  readonly service: ServiceName;
  readonly attempts: number;
  readonly lastStatus?: string;
}

export type HealthcheckRunError = HealthcheckTimeoutError | HealthcheckError;

export interface HealthcheckRunnerShape {
  readonly id: string;
  readonly run: (
    plan: HealthcheckPlan,
    appId: AppId,
    service: ServiceName,
  ) => Effect.Effect<HealthcheckResult, HealthcheckRunError>;
}

export class HealthcheckRunner extends Context.Tag("@lando/core/HealthcheckRunner")<
  HealthcheckRunner,
  HealthcheckRunnerShape
>() {}

export interface ScanEndpoint {
  readonly service: ServiceName;
  readonly url: string;
  readonly reachable: boolean;
  readonly statusCode?: number;
}

export interface ScanResult {
  readonly appId: AppId;
  readonly endpoints: ReadonlyArray<ScanEndpoint>;
}

export interface PortCollision {
  readonly port: number;
  readonly apps: ReadonlyArray<{ readonly appId: AppId; readonly service: ServiceName }>;
}

export interface UrlScannerShape {
  readonly id: string;
  readonly scan: (appId: AppId) => Effect.Effect<ScanResult, ScannerError>;
  readonly detectCollisions: (
    appIds: ReadonlyArray<AppId>,
  ) => Effect.Effect<ReadonlyArray<PortCollision>, ScannerError | PortCollisionError>;
}

export class UrlScanner extends Context.Tag("@lando/core/UrlScanner")<UrlScanner, UrlScannerShape>() {}

/**
 * `HostProxyService` resolves `*.<base-domain>` (default `lndo.site`) to a
 * loopback address so users do not have to edit `/etc/hosts` themselves.
 *
 * Default platform behavior:
 * - macOS: write `/etc/resolver/<base-domain>` (no `/etc/hosts` edit)
 * - Linux: write `/etc/hosts` block or `systemd-resolved` drop-in
 * - Windows: write the HOSTS file
 *
 * Privileged operations happen at `lando setup` time only (gated behind a
 * sudo/UAC prompt). They MUST NOT run inline during `lando start`.
 *
 * Users who manage their own DNS can opt out by running
 * `lando setup --host-proxy=none`, which selects the `none` mode and reports
 * an inactive `HostProxyStatus`.
 */
export type HostProxyMode = "auto" | "none";

export type HostProxyMechanism = "etc-hosts" | "etc-resolver" | "hosts-file" | "skipped" | "none";

export interface HostProxySetupOptions {
  readonly mode: HostProxyMode;
  readonly baseDomain?: string;
  readonly loopback?: string;
  readonly force?: boolean;
}

export interface HostProxyStatus {
  readonly active: boolean;
  readonly mode: HostProxyMode;
  readonly mechanism: HostProxyMechanism;
  readonly baseDomain: string;
  readonly loopback: string;
}

export interface HostProxyServiceShape {
  readonly id: string;
  readonly setup: (options: HostProxySetupOptions) => Effect.Effect<void, HostProxyError>;
  readonly status: () => Effect.Effect<HostProxyStatus, HostProxyError>;
  readonly teardown: () => Effect.Effect<void, HostProxyError>;
}

export class HostProxyService extends Context.Tag("@lando/core/HostProxyService")<
  HostProxyService,
  HostProxyServiceShape
>() {}

/**
 * PluginSource — resolve and fetch a plugin spec.
 */
export class PluginSource extends Context.Tag("@lando/core/PluginSource")<
  PluginSource,
  {
    readonly id: string;
  }
>() {}

/**
 * UpdateService — check/apply updates to core and plugins.
 */
export class UpdateService extends Context.Tag("@lando/core/UpdateService")<
  UpdateService,
  {
    readonly id: string;
  }
>() {}

/**
 * SecretStore — resolve `${secret:...}` references in Landofiles.
 *
 * Default: env-var store.
 */
export class SecretStore extends Context.Tag("@lando/core/SecretStore")<
  SecretStore,
  {
    readonly id: string;
  }
>() {}

/**
 * FileSyncEngineShape — lifecycle surface every `FileSyncEngine` plugin
 * implements.
 *
 * Engines are session-stateful: one session per accelerated `MountPlan`
 * per started app. `createSession` is `Scope`-acquired so app stop and
 * interruption both flow through the standard finalisation path.
 */
export interface FileSyncEngineShape {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: FileSyncEngineCapabilities;

  readonly isAvailable: Effect.Effect<boolean, FileSyncError>;
  readonly setup: (options: FileSyncSetupOptions) => Effect.Effect<void, FileSyncError, Scope.Scope>;

  readonly createSession: (
    spec: FileSyncSessionSpec,
  ) => Effect.Effect<FileSyncSessionRef, FileSyncError, Scope.Scope>;
  readonly pauseSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
  readonly resumeSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
  readonly terminateSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;

  readonly listSessions: (
    filter: FileSyncSessionFilter,
  ) => Effect.Effect<ReadonlyArray<FileSyncSessionInfo>, FileSyncError>;
  readonly streamEvents: (ref: FileSyncSessionRef) => Stream.Stream<FileSyncEventChunk, FileSyncError>;
}

/**
 * FileSyncEngine — pluggable accelerated bind-mount engine. Default
 * implementation is the no-op `passthrough`; the bundled default for
 * `bindMountPerformance: "slow"` providers is `@lando/file-sync-mutagen`.
 */
export class FileSyncEngine extends Context.Tag("@lando/core/FileSyncEngine")<
  FileSyncEngine,
  FileSyncEngineShape
>() {}

export type { AppId, ServiceName, ServiceInfo };
