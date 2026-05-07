/**
 * Effect Service tags — the contract index.
 *
 * Catalogs the default Effect Service tags and pluggable abstractions. This
 * module declares only the **tags** (with their interface shapes) so plugin
 * authors can target them. Live Layers live in `@lando/core` (default) or
 * in plugin packages (replacements).
 *
 * Pattern: we use the modern Effect 3.x `Context.Tag` class-extending
 * pattern, i.e. `Context.Tag(id)<Self, Shape>()`.
 *
 * Status: stub interfaces — methods are typed but Live impls don't exist
 * yet.
 */
import { Context, type Effect, type Stream } from "effect";

// Re-export branded primitives so downstream tags can reference them.
import type {
  AppId,
  AppPlan,
  GlobalConfig,
  HostPlatform,
  LandofileShape,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  ServiceInfo,
  ServiceName,
} from "../schema/index.ts";

import type {
  CacheError,
  ConfigError,
  EventError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  PluginLoadError,
  PluginManifestError,
  ProviderConfigError,
  ProviderInternalError,
  ProviderUnavailableError,
} from "../errors/index.ts";

// =============================================================================
// Core services
// =============================================================================

/**
 * ConfigService — global config + env overrides.
 */
export class ConfigService extends Context.Tag("@lando/core/ConfigService")<
  ConfigService,
  {
    readonly load: Effect.Effect<GlobalConfig, ConfigError>;
    readonly get: <K extends keyof GlobalConfig>(key: K) => Effect.Effect<GlobalConfig[K], ConfigError>;
  }
>() {}

/**
 * LandofileService — Landofile discovery, parse, merge, validate.
 */
export class LandofileService extends Context.Tag("@lando/core/LandofileService")<
  LandofileService,
  {
    readonly discover: Effect.Effect<
      LandofileShape,
      LandofileNotFoundError | LandofileParseError | LandofileValidationError
    >;
  }
>() {}

/**
 * PluginRegistry — manifest loading, contribution graph.
 */
export class PluginRegistry extends Context.Tag("@lando/core/PluginRegistry")<
  PluginRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<PluginManifest>, PluginManifestError>;
    readonly load: (name: string) => Effect.Effect<PluginManifest, PluginLoadError | PluginManifestError>;
  }
>() {}

/**
 * CommandRegistry — OCLIF + tooling command registration.
 */
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

/**
 * RuntimeProviderRegistry — provider discovery + selection.
 */
export class RuntimeProviderRegistry extends Context.Tag("@lando/core/RuntimeProviderRegistry")<
  RuntimeProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderId>, ProviderUnavailableError>;
    readonly select: (
      plan: AppPlan,
    ) => Effect.Effect<RuntimeProvider, ProviderUnavailableError | ProviderConfigError>;
  }
>() {}

/**
 * RuntimeProvider.
 *
 * Only the surface is declared here; the heavy types (ApplyOptions,
 * ExecTarget, LogTarget, ServiceSelector, etc.) are stubs that will expand
 * into Effect Schemas in `../schema/index.ts`.
 */
export interface RuntimeProviderShape {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly platform: HostPlatform;
  readonly capabilities: ProviderCapabilities;

  readonly isAvailable: Effect.Effect<boolean, ProviderUnavailableError>;
  readonly getStatus: Effect.Effect<unknown, ProviderInternalError>;

  readonly apply: (
    plan: AppPlan,
    options: { readonly reconcile: boolean },
  ) => Effect.Effect<unknown, ProviderInternalError>;
}

export class RuntimeProvider extends Context.Tag("@lando/core/RuntimeProvider")<
  RuntimeProvider,
  RuntimeProviderShape
>() {}

/**
 * AppPlanner — recipe expansion, service plan, route plan.
 */
export class AppPlanner extends Context.Tag("@lando/core/AppPlanner")<
  AppPlanner,
  {
    readonly plan: (landofile: LandofileShape) => Effect.Effect<AppPlan, never>;
  }
>() {}

/**
 * EventService — pub/sub over typed lifecycle events.
 *
 * Note: `LandoEvent` is a placeholder; the full discriminated union of
 * event payloads lives in `../events/index.ts` and grows as features land.
 */
export interface LandoEvent {
  readonly _tag: string;
}

export class EventService extends Context.Tag("@lando/core/EventService")<
  EventService,
  {
    readonly publish: (event: LandoEvent) => Effect.Effect<void, EventError>;
    readonly subscribe: (name: string) => Stream.Stream<LandoEvent, EventError>;
    readonly waitFor: (
      name: string,
      filter?: (event: LandoEvent) => boolean,
    ) => Effect.Effect<LandoEvent, EventError>;
  }
>() {}

/**
 * CacheService — atomic cache reads/writes, invalidation.
 */
export class CacheService extends Context.Tag("@lando/core/CacheService")<
  CacheService,
  {
    readonly read: <A>(key: string) => Effect.Effect<A | null, CacheError>;
    readonly write: <A>(key: string, value: A) => Effect.Effect<void, CacheError>;
    readonly invalidate: (key: string) => Effect.Effect<void, CacheError>;
  }
>() {}

// =============================================================================
// Platform services
// =============================================================================

/**
 * FileSystem — Bun.file/Bun.write wrapper.
 *
 * Replaceable for sandboxing or remote-FS.
 */
export class FileSystem extends Context.Tag("@lando/core/FileSystem")<
  FileSystem,
  {
    readonly readFile: (path: string) => Effect.Effect<string, CacheError>;
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, CacheError>;
    readonly writeAtomic: (path: string, content: string) => Effect.Effect<void, CacheError>;
    readonly exists: (path: string) => Effect.Effect<boolean, CacheError>;
  }
>() {}

/**
 * ProcessRunner — Bun.spawn wrapper.
 *
 * Replaceable for telemetry, sandbox, dry-run modes.
 */
export interface ProcessSpawnOptions {
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ProcessRunner extends Context.Tag("@lando/core/ProcessRunner")<
  ProcessRunner,
  {
    readonly spawn: (options: ProcessSpawnOptions) => Effect.Effect<ProcessResult, never>;
  }
>() {}

/**
 * PrivilegeService — sudo/UAC dispatch.
 */
export class PrivilegeService extends Context.Tag("@lando/core/PrivilegeService")<
  PrivilegeService,
  {
    readonly elevate: (command: ReadonlyArray<string>) => Effect.Effect<ProcessResult, never>;
  }
>() {}

// =============================================================================
// Logging + rendering
// =============================================================================

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
    readonly id: string;
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

// =============================================================================
// Optional / pluggable abstractions
// =============================================================================

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
 * ToolingEngine — translate a tooling invocation into a sequence of provider
 * operations. Default: `providerExec`.
 */
export class ToolingEngine extends Context.Tag("@lando/core/ToolingEngine")<
  ToolingEngine,
  {
    readonly id: string;
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

// Re-export tags useful to plug-everything plugin authors. The unused-import
// vars (ServiceName, ServiceInfo) above are referenced by future Live impls.
export type { AppId, ServiceName, ServiceInfo };
