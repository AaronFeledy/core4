/** Effect service tags for the SDK. */
import { Context, type Effect, type Queue, type Schema, type Scope, type Stream } from "effect";

import type {
  AppId,
  AppPlan,
  EndpointPlan,
  GlobalConfig,
  HostPlatform,
  LandofileShape,
  PlanMetadata,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  RecipeManifest,
  ServiceConfig,
  ServiceInfo,
  ServiceName,
  ServicePlan,
} from "../schema/index.ts";

import type {
  CacheError,
  CapabilityError,
  ConfigError,
  EventError,
  FileIoError,
  FileNotFoundError,
  FilePermissionError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginLoadError,
  PluginManifestError,
  ProcessExecError,
  ProcessTimeoutError,
  ProviderCapabilityError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderUnavailableError,
  RecipeManifestNotFoundError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
  ShellExecError,
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
 *
 * Not user-swappable in v4.0; the interface exists for future extensibility.
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

/**
 * CertificateAuthority — generate/store dev CA, issue leaf certs.
 *
 * Default: `@lando/ca-mkcert`.
 */
export class CertificateAuthority extends Context.Tag("@lando/core/CertificateAuthority")<
  CertificateAuthority,
  {
    readonly id: string;
  }
>() {}

/**
 * ProxyService — realize RoutePlans into running ingress.
 *
 * Default: `@lando/proxy-traefik`.
 */
export class ProxyService extends Context.Tag("@lando/core/ProxyService")<
  ProxyService,
  {
    readonly id: string;
  }
>() {}

/**
 * HealthcheckRunner — execute a HealthcheckPlan and report status.
 */
export class HealthcheckRunner extends Context.Tag("@lando/core/HealthcheckRunner")<
  HealthcheckRunner,
  {
    readonly id: string;
  }
>() {}

/**
 * UrlScanner — probe URLs after start.
 */
export class UrlScanner extends Context.Tag("@lando/core/UrlScanner")<
  UrlScanner,
  {
    readonly id: string;
  }
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

export type { AppId, ServiceName, ServiceInfo };
