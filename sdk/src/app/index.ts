import type { Schema } from "effect";
// `@lando/sdk/app` — stable App-handle contract surface for embedding hosts.
//
// These are the canonical, semver-stable contracts an embedding host consumes
// when it resolves an app once and drives lifecycle/introspection/tooling/
// config/logs/event operations through a single handle. `@lando/core` owns the
// implementations returned by `resolveApp` / `openLandoRuntime` and re-exports
// these types. The handle is **opaque/branded**: hosts consume `App` values
// they are handed; they do not structurally implement the interface, which keeps
// future method additions non-breaking inside the 4.x line.

import type { Effect, Scope, Stream } from "effect";

import type {
  AppIdReservedError,
  AppLockTimeoutError,
  AppPlacementError,
  AppResolveError,
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  CacheError,
  CommandAliasConflictError,
  EventError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  GlobalAutoStartError,
  GpgAgentTransportError,
  GpgAgentUnavailableError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
  Lando3LandofileDetected,
  LandoCommandError,
  LandofileDialectMixError,
  LandofileEventInvocationDepthError,
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  LandofileEventsSkippedError,
  LandofileFormConflictError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileNotFoundError as LandofileMissingError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  LandofileVersionConstraintError,
  ManagedFileTransactionError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
  ProxyApplyError,
  ProxyError,
  ProxySetupError,
  RemoteError,
  RemoteProtectedEnvError,
  RemoteProviderUnavailableError,
  RouteInputError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
  ScratchAppError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
  ServiceNotReadyError,
  ShellExecError,
  ShellScriptOutsideRootError,
  SshAgentTransportError,
  SshAgentUnavailableError,
  StateStoreError,
  ToolingCompileError,
  ToolingDisabledError,
  ToolingExecError,
  ToolingInputError,
  TunnelProviderUnavailableError,
  VolumeOperationError,
} from "../errors/index.ts";

type LandofileNotFoundError = LandofileMissingError | LandofileFormConflictError;
import type {
  AbsolutePath,
  AppPlan,
  AppRef,
  CheckResult,
  ConfigLintResult,
  DatasetKind,
  LandofileShape,
  ProviderId,
  RemoteConfig,
  RemoteEnvironment,
  RemoteTestResult,
  ServiceInfo,
  ServiceInfoLogSource,
  ServiceName,
  StartedService,
  SyncResult,
  TunnelSession,
  TunnelTarget,
} from "../schema/index.ts";
import type { LandoEvent } from "../services/events.ts";
export type { EndpointRef, ServiceConnection, ServiceState, StartedService } from "../schema/index.ts";
import type {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  DataMover,
  DataMoverError,
  DatasetServiceError,
  Downloader,
  EventService,
  FileSystem,
  GlobalAppService,
  InteractionError,
  LandofileService,
  Logger,
  ManagedFileService,
  ManagedFileTransactionGuard,
  PathsService,
  PluginRegistry,
  PluginTrustStore,
  PrivilegeService,
  ProcessRunner,
  RemoteSourceError,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  StateStore,
  Telemetry,
  ToolingEngine,
  TunnelError,
} from "../services/index.ts";
import type { UserLandofileError } from "../services/landofile.ts";
import type { AppPlannerError, BuildAppError, BuildError } from "../services/planner.ts";
import type { LogChunk, ProviderError, ProviderSelectionError } from "../services/provider.ts";
import type { ScratchAcquireInput, ScratchHandle } from "../services/scratch.ts";

/**
 * The union of every Effect service tag a fully-bootstrapped app-tier Lando
 * runtime provides. `LandoRuntime.run` excludes these from a host program's
 * requirement channel because the retained runtime already satisfies them.
 */
export type LandoRuntimeServices =
  | import("../services/host-assets.ts").ContainerHelperAssets
  | Logger
  | Renderer
  | Telemetry
  | ConfigService
  | FileSystem
  | CacheService
  | ManagedFileService
  | ManagedFileTransactionGuard
  | PathsService
  | PluginTrustStore
  | PrivilegeService
  | ProcessRunner
  | Downloader
  | StateStore
  | PluginRegistry
  | RuntimeProvider
  | RuntimeProviderRegistry
  | GlobalAppService
  | LandofileService
  | CommandRegistry
  | AppPlanner
  | DataMover
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
  readonly checks?: ReadonlyArray<CheckResult>;
  readonly app: string;
  readonly servicesStarted: readonly StartedService[];
}

export type AppPlanResolutionError = UserLandofileError | ProviderSelectionError | AppPlannerError;

export type StartAppError =
  | AppPlacementError
  | AppResolveError
  | ServiceNotReadyError
  | UserLandofileError
  | AppPlannerError
  | ProviderSelectionError
  | BuildAppError
  | LandofileEventLifecycleReentryError
  | LandofileEventInvocationDepthError
  | LandofileEventStepFailedError
  | ToolingCompileError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | GlobalAutoStartError
  | SecretNotFoundError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError
  | SshAgentUnavailableError
  | SshAgentTransportError
  | GpgAgentUnavailableError
  | GpgAgentTransportError
  | HostProxySocketStaleError
  | HostProxyTransportUnavailableError
  | LandoCommandError
  | ProxyApplyError
  | ProxyError
  | ProxySetupError
  | RouterPortPinMismatch
  | RouterPortsExhausted
  | RouterWatcherError
  | AppLockTimeoutError
  | StateStoreError
  | VolumeOperationError;

// biome-ignore lint/complexity/noBannedTypes: stop has no extra options beyond start today.
export type StopAppOptions = {};

/**
 * Whether a lifecycle operation ran the Landofile's `events:` and `hostEvents` steps. `skipped`
 * names why it could not source them: no Landofile at the applied root, a Landofile that
 * failed to load, or one that describes another app or provider.
 */
export type LandofileEventsOutcome =
  | { readonly status: "ran" }
  | { readonly status: "skipped"; readonly reason: string };

export interface StopAppResult {
  readonly app: string;
  readonly outcome?: "stopped" | "unchanged";
  readonly servicesStopped: ReadonlyArray<string>;
  /** Present when the operation tore down an app whose Landofile steps could have run. */
  readonly landofileEvents?: LandofileEventsOutcome;
}

export type StopAppError =
  | Lando3LandofileDetected
  | LandofileDialectMixError
  | AppPlannerError
  | BuildError
  | ManagedFileTransactionError
  | AppIdReservedError
  | AppResolveError
  | LandofileEventLifecycleReentryError
  | LandofileEventInvocationDepthError
  | LandofileEventStepFailedError
  | ToolingCompileError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileVersionConstraintError
  | LandoCommandError
  | AppLockTimeoutError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | StateStoreError
  | VolumeOperationError;

export interface RestartAppOptions {
  readonly reconcile?: boolean;
  readonly signal?: AbortSignal;
  /** Restart only these planned services. Unknown names fail with `ServiceNotFoundError`. */
  readonly services?: ReadonlyArray<ServiceName>;
}

export interface RestartAppResult {
  readonly checks?: ReadonlyArray<CheckResult>;
  readonly app: string;
  readonly servicesStarted: StartAppResult["servicesStarted"];
}

export type RestartAppError = StartAppError | AppResolveError | ProviderError;

export interface RebuildAppOptions {
  readonly services?: ReadonlyArray<ServiceName>;
  readonly signal?: AbortSignal;
}

export interface RebuildAppResult {
  readonly checks?: ReadonlyArray<CheckResult>;
  readonly app: string;
  readonly servicesRebuilt: ReadonlyArray<string>;
  readonly servicesStarted: StartAppResult["servicesStarted"];
}

export type RebuildAppError = StartAppError | AppResolveError;

export interface DestroyAppOptions {
  readonly providerId?: ProviderId;
  readonly volumes?: boolean;
  readonly purgeCaches?: boolean;
  readonly purgeSnapshots?: boolean;
  readonly yes?: boolean;
}

export interface DestroyAppResult {
  readonly app: string;
  readonly outcome?: "destroyed" | "unchanged";
  readonly servicesDestroyed: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
  readonly snapshotsRemoved: number;
  /** Present when the operation tore down an app whose Landofile steps could have run. */
  readonly landofileEvents?: LandofileEventsOutcome;
}

export type DestroyAppError =
  | StopAppError
  | LandofileEventsSkippedError
  | ProxyError
  | StateStoreError
  | CacheError
  | DataMoverError
  | ProviderSelectionError;

export interface InfoAppOptions {
  readonly deep?: boolean;
  readonly services?: ReadonlyArray<ServiceName>;
  readonly path?: string;
  readonly filters?: ReadonlyArray<string>;
}

export type InfoServiceStatus = ServiceInfo["status"];
export type InfoLogSourceAvailability = ServiceInfoLogSource["availability"];
export type InfoLogSource = ServiceInfoLogSource;
export type InfoAppService = ServiceInfo;

export interface InfoAppAgentEnv {
  readonly enabled: boolean;
  readonly forwarded: ReadonlyArray<string>;
}

export interface InfoAppResult {
  readonly app: string;
  readonly services: ReadonlyArray<InfoAppService>;
  readonly agentEnv?: InfoAppAgentEnv;
}

export type InfoAppError =
  | StateStoreError
  | AppResolveError
  | UserLandofileError
  | AppPlannerError
  | ProviderSelectionError
  | ProviderError
  | LandoCommandError
  | ProxyError;

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
  | UserLandofileError
  | AppPlannerError
  | ProviderSelectionError
  | ProviderError
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
  /** Explicitly request a provider PTY. Omission remains noninteractive. */
  readonly tty?: boolean;
}

export interface ToolingResult {
  readonly tool: string;
  readonly service: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ToolingError =
  | CommandAliasConflictError
  | UserLandofileError
  | AppPlannerError
  | ProviderSelectionError
  | ProviderError
  | LandofileEventLifecycleReentryError
  | LandofileEventInvocationDepthError
  | LandofileEventStepFailedError
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | ShellExecError
  | ShellScriptOutsideRootError
  | ToolingCompileError
  | ToolingDisabledError
  | ToolingInputError
  | ToolingExecError;

export interface LogsAppOptions {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
  /** Restrict the stream to a single declared source id (or the implicit `console`). */
  readonly source?: string;
}

export type LogsAppError =
  | StateStoreError
  | AppResolveError
  | Lando3LandofileDetected
  | LandofileDialectMixError
  | AppPlannerError
  | ProviderSelectionError
  | ProviderError
  | ManagedFileTransactionError
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileVersionConstraintError
  | LandoCommandError
  | ToolingExecError;

export interface RemoteSyncOptions {
  readonly remote?: string;
  readonly env?: string;
  readonly only?: ReadonlyArray<DatasetKind>;
  readonly noSnapshot?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly noInteractive?: boolean;
}

export type PullAppOptions = RemoteSyncOptions;
export type PushAppOptions = RemoteSyncOptions;

export interface ShareAppOptions {
  readonly target?: TunnelTarget;
  readonly provider?: string;
  readonly detach?: boolean;
  readonly yes?: boolean;
}

export interface ShareStopAppOptions {
  readonly sessionId: string;
  readonly provider?: string;
  readonly force?: boolean;
}

export interface ShareStopAppResult {
  readonly sessionId: string;
  readonly provider?: string;
  readonly status: "stopped";
}

export type ShareAppError =
  | TunnelError
  | TunnelProviderUnavailableError
  | AppResolveError
  | StateStoreError
  | Schema.SchemaError;

export type RemoteSyncError =
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileVersionConstraintError
  | RemoteSourceError
  | DatasetServiceError
  | DataMoverError
  | InteractionError;

export type PullAppError = RemoteSyncError;
export type PushAppError = RemoteSyncError | RemoteProtectedEnvError | RemoteProviderUnavailableError;

export interface AppRemoteEntry {
  readonly name: string;
  readonly config: RemoteConfig;
}

export interface AppRemoteMutationOptions {
  readonly name: string;
  readonly config: RemoteConfig;
}

export interface AppRemoteRemoveOptions {
  readonly name: string;
}

export interface AppRemoteMutationResult {
  readonly app: string;
  readonly remote: string;
  readonly file: string;
  readonly config: RemoteConfig;
}

export interface AppRemoteTestOptions {
  readonly remote?: string;
  readonly env?: string;
}

export interface AppRemoteSetupOptions extends AppRemoteTestOptions {
  readonly force?: boolean;
}

export interface AppRemoteApi {
  readonly list: () => Effect.Effect<
    ReadonlyArray<AppRemoteEntry>,
    LandofileNotFoundError | LandofileParseError
  >;
  readonly add: (
    options: AppRemoteMutationOptions,
  ) => Effect.Effect<AppRemoteMutationResult, LandofileNotFoundError | LandofileParseError>;
  readonly remove: (
    options: AppRemoteRemoveOptions,
  ) => Effect.Effect<
    AppRemoteMutationResult,
    LandofileNotFoundError | LandofileParseError | RemoteError | RemoteProviderUnavailableError
  >;
  readonly test: (options?: AppRemoteTestOptions) => Effect.Effect<RemoteTestResult, RemoteSyncError>;
  readonly setup: (options?: AppRemoteSetupOptions) => Effect.Effect<RemoteTestResult, RemoteSyncError>;
  readonly env: {
    readonly list: (
      options?: AppRemoteTestOptions,
    ) => Effect.Effect<ReadonlyArray<RemoteEnvironment>, RemoteSyncError>;
  };
}

export interface AppConfigLintOptions {
  readonly cwd?: string;
}

export interface AppConfigApi {
  readonly lint: (
    options?: AppConfigLintOptions,
  ) => Effect.Effect<
    ConfigLintResult,
    LandofileNotFoundError | LandofileValidationError | NotImplementedError
  >;
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
 * foreground `share`, `logs`, `events.subscribe`) keep `Scope.Scope` in `R` so
 * the host owns the subscription/resource lifetime.
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
  readonly pull: (options?: PullAppOptions) => Effect.Effect<SyncResult, PullAppError>;
  readonly push: (options?: PushAppOptions) => Effect.Effect<SyncResult, PushAppError>;
  readonly share: (options?: ShareAppOptions) => Effect.Effect<TunnelSession, ShareAppError, Scope.Scope>;
  readonly shareList: () => Effect.Effect<ReadonlyArray<TunnelSession>, ShareAppError>;
  readonly shareStop: (options: ShareStopAppOptions) => Effect.Effect<ShareStopAppResult, ShareAppError>;
  readonly remote: AppRemoteApi;
  readonly config: AppConfigApi;
  readonly events: AppEventsApi;
}

/** Resolution union for `runtime.scratch`. */
export type ScratchAcquireError =
  | ScratchAppError
  | AppPlacementError
  | ScratchSourceUnresolvedError
  | ScratchIsolationConflictError
  | LandofileVersionConstraintError;

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
