// `@lando/sdk/app` — stable App-handle contract surface for embedding hosts.
//
// These are the canonical, semver-stable contracts an embedding host consumes
// when it resolves an app once and drives lifecycle/introspection/tooling/
// config/logs/event operations through a single handle. `@lando/core` owns the
// implementations returned by `resolveApp` / `openLandoRuntime` and re-exports
// these types. The handle is **opaque/branded**: hosts consume `App` values
// they are handed; they do not structurally implement the interface, which keeps
// future method additions non-breaking inside the 4.x line.
//
// Scope note: tunnel (`share*`) and remote-sync (`pull`/`push`/`remote`) methods
// and their types are intentionally NOT part of this surface yet; they are added
// non-breakingly in later releases. The brand is what makes that safe.

import type { Effect, Scope, Stream } from "effect";

import type {
  AppIdReservedError,
  AppResolveError,
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  CapabilityError,
  EventError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  GlobalAutoStartError,
  LandoCommandError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
  ScratchAppError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
  ShellExecError,
  ShellScriptOutsideRootError,
  ToolingCompileError,
  ToolingExecError,
} from "../errors/index.ts";
import type { AbsolutePath, AppPlan, AppRef, ConfigLintResult, LandofileShape } from "../schema/index.ts";
import type { LandoEvent } from "../services/events.ts";
import type {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  Downloader,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  Logger,
  ManagedFileService,
  PluginRegistry,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  Telemetry,
  ToolingEngine,
} from "../services/index.ts";
import type { LogChunk, ProviderError } from "../services/provider.ts";
import type { ScratchAcquireInput, ScratchHandle } from "../services/scratch.ts";

/**
 * The union of every Effect service tag a fully-bootstrapped app-tier Lando
 * runtime provides. `LandoRuntime.run` excludes these from a host program's
 * requirement channel because the retained runtime already satisfies them.
 */
export type LandoRuntimeServices =
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | FileSystem
  | CacheService
  | ManagedFileService
  | PluginTrustStore
  | PrivilegeService
  | ProcessRunner
  | Downloader
  | PluginRegistry
  | RuntimeProvider
  | RuntimeProviderRegistry
  | GlobalAppService
  | LandofileService
  | CommandRegistry
  | AppPlanner
  | EventService
  | ToolingEngine;

/**
 * Selects the app a handle resolves to. Precedence is `id > landofile > root >
 * cwd`. Passing more than one field is allowed only when the higher-precedence
 * field validates against the lower; a mismatch fails with `AppResolveError`. A
 * decoded `LandofileShape` selector MUST carry an explicit `root`. A missing
 * selector resolves from the retained runtime `cwd` (or the runtime's acquired
 * scratch app, when constructed with the `scratch` option).
 *
 * Distinct from the provider-tier `AppSelector` in `@lando/sdk/services`, which
 * targets an already-resolved app/plan for provider operations.
 */
export type AppSelector =
  | { readonly id: string; readonly root?: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly landofile: AbsolutePath; readonly root?: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly landofile: LandofileShape; readonly root: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly root: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly cwd: AbsolutePath };

export interface StartAppOptions {
  readonly reconcile?: boolean;
  readonly signal?: AbortSignal;
  /**
   * App-handle start mode. Defaults to `false`. When omitted or `false`, the
   * handle keeps the started resources alive in a managed scope and tears them
   * down on `stop`/`restart`/`destroy` or runtime-scope close. When `true`, the
   * handle starts provider resources without registering a handle-owned stop
   * finalizer (matching CLI detached-start semantics). Ignored by the
   * `@lando/core/cli` `startApp` operation, which never manages a scope.
   */
  readonly detached?: boolean;
}

export interface StartAppResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<{
    readonly name: string;
    readonly state: string;
    readonly endpoints: ReadonlyArray<string>;
  }>;
}

export type StartAppError =
  | AppIdReservedError
  | EventError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError
  | CapabilityError
  | GlobalAutoStartError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

// biome-ignore lint/complexity/noBannedTypes: stop has no extra options beyond start today.
export type StopAppOptions = {};

export interface StopAppResult {
  readonly app: string;
  readonly servicesStopped: ReadonlyArray<string>;
}

export type StopAppError =
  | AppIdReservedError
  | EventError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

export interface RestartAppOptions {
  readonly reconcile?: boolean;
  readonly signal?: AbortSignal;
}

export interface RestartAppResult {
  readonly app: string;
  readonly servicesStarted: StartAppResult["servicesStarted"];
}

export type RestartAppError = StartAppError;

export interface RebuildAppOptions {
  readonly signal?: AbortSignal;
}

export interface RebuildAppResult {
  readonly app: string;
  readonly servicesRebuilt: ReadonlyArray<string>;
  readonly servicesStarted: StartAppResult["servicesStarted"];
}

export type RebuildAppError = StartAppError;

export interface DestroyAppOptions {
  readonly volumes?: boolean;
  readonly yes?: boolean;
}

export interface DestroyAppResult {
  readonly app: string;
  readonly servicesDestroyed: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
}

export type DestroyAppError = StopAppError;

export interface InfoAppOptions {
  readonly deep?: boolean;
  readonly service?: string;
  readonly path?: string;
  readonly filters?: ReadonlyArray<string>;
}

export type InfoServiceStatus =
  | "unknown"
  | "stopped"
  | "starting"
  | "running"
  | "healthy"
  | "unhealthy"
  | "error";

export interface InfoAppService {
  readonly app: string;
  readonly service: string;
  readonly api: 4;
  readonly type: string;
  readonly provider: string;
  readonly primary: boolean;
  readonly status: InfoServiceStatus;
  readonly endpoints: ReadonlyArray<string>;
}

export interface InfoAppResult {
  readonly app: string;
  readonly services: ReadonlyArray<InfoAppService>;
}

export type InfoAppError =
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

export interface ExecAppOptions {
  readonly service?: string;
  readonly command: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly tty?: boolean;
}

export interface ExecAppResult {
  readonly app: string;
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecAppError =
  | AppIdReservedError
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError;

/**
 * Tooling invocation options. The tool id is passed as the first positional
 * argument to `app.tooling(id, options?)`, so it is not part of this object.
 */
export interface ToolingOptions {
  readonly args?: ReadonlyArray<string>;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cacheRoot?: string;
  readonly renderProgress?: boolean;
}

export interface ToolingResult {
  readonly tool: string;
  readonly service: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly rendered?: boolean;
}

export type ToolingError =
  | AppIdReservedError
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | CapabilityError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ShellExecError
  | ShellScriptOutsideRootError
  | ToolingCompileError
  | ToolingExecError;

export interface LogsAppOptions {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
}

export type LogsAppError =
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError;

/** Options for `App.config.lint`. */
export interface AppConfigLintOptions {
  readonly cwd?: string;
}

/**
 * Configuration sub-API of an `App` handle. Canonical-schema lint today; config
 * read/write methods may be added non-breakingly in later releases.
 */
export interface AppConfigApi {
  readonly lint: (options?: AppConfigLintOptions) => Effect.Effect<ConfigLintResult, LandofileNotFoundError>;
}

/**
 * Event sub-API of an `App` handle. `subscribe` opens a scoped stream of
 * lifecycle events; the caller's `Scope` owns the subscription lifetime.
 */
export interface AppEventsApi {
  readonly subscribe: (name?: string) => Stream.Stream<LandoEvent, EventError, Scope.Scope>;
}

declare const AppBrand: unique symbol;

/**
 * A stable, Effect-native handle to one resolved Lando app. Returned by
 * `resolveApp` / `runtime.app`; the implementation is owned by `@lando/core`
 * and is opaque/branded so hosts consume handles but do not implement this
 * interface structurally.
 *
 * One-shot methods have `R = never` after binding because the handle already
 * carries the runtime. Methods that expose live resources (`exec`, `tooling`,
 * `logs`, `events.subscribe`) keep `Scope.Scope` in `R` so the host owns the
 * subscription/resource lifetime.
 */
export interface App {
  readonly [AppBrand]: never;
  readonly id: string;
  readonly ref: AppRef;
  readonly root: AbsolutePath;
  readonly plan: Effect.Effect<AppPlan, AppResolveError>;
  readonly start: (options?: StartAppOptions) => Effect.Effect<StartAppResult, StartAppError>;
  readonly stop: (options?: StopAppOptions) => Effect.Effect<StopAppResult, StopAppError>;
  readonly restart: (options?: RestartAppOptions) => Effect.Effect<RestartAppResult, RestartAppError>;
  readonly rebuild: (options?: RebuildAppOptions) => Effect.Effect<RebuildAppResult, RebuildAppError>;
  readonly destroy: (options?: DestroyAppOptions) => Effect.Effect<DestroyAppResult, DestroyAppError>;
  readonly info: (options?: InfoAppOptions) => Effect.Effect<InfoAppResult, InfoAppError>;
  readonly exec: (options: ExecAppOptions) => Effect.Effect<ExecAppResult, ExecAppError, Scope.Scope>;
  readonly tooling: (
    id: string,
    options?: ToolingOptions,
  ) => Effect.Effect<ToolingResult, ToolingError, Scope.Scope>;
  readonly logs: (options?: LogsAppOptions) => Stream.Stream<LogChunk, LogsAppError, Scope.Scope>;
  readonly config: AppConfigApi;
  readonly events: AppEventsApi;
}

/** Resolution union for `runtime.scratch`. */
export type ScratchAcquireError =
  | ScratchAppError
  | ScratchSourceUnresolvedError
  | ScratchIsolationConflictError;

/**
 * The object returned by `openLandoRuntime`. Its methods are bound to a single
 * retained runtime acquisition held in the caller's `Scope`.
 */
export interface LandoRuntime {
  readonly app: (selector?: AppSelector) => Effect.Effect<App, AppResolveError>;
  readonly scratch: (
    input: ScratchAcquireInput,
  ) => Effect.Effect<ScratchHandle, ScratchAcquireError, Scope.Scope>;
  readonly run: <A, E, R>(
    program: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, LandoRuntimeServices>>;
}
