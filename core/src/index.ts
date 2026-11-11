/**
 * `@lando/core` — public library API entry point.
 *
 * Public API surface for the `LandoRuntime` factory.
 *
 * **Stability:** this library surface is unstable and published only on
 * dev/next channels. New exports require a library-API
 * contract test.
 *
 * **Boundary rule:** importing this entry point MUST NOT pull `@oclif/core`
 * into the import graph. An embedding host that never invokes the CLI must
 * not pay for OCLIF in its bundle. Enforced by the library import-boundary test.
 */

export type { BootstrapLevel } from "@lando/engine/runtime/bootstrap";
export type {
  App,
  AppConfigApi,
  AppConfigLintOptions,
  AppEventsApi,
  AppRemoteApi,
  AppRemoteEntry,
  AppRemoteMutationOptions,
  AppRemoteMutationResult,
  AppRemoteRemoveOptions,
  AppRemoteSetupOptions,
  AppRemoteTestOptions,
  AppSelector,
  DestroyAppError,
  DestroyAppOptions,
  DestroyAppResult,
  ExecAppError,
  ExecAppOptions,
  ExecAppResult,
  InfoAppError,
  InfoAppOptions,
  InfoAppResult,
  InfoAppService,
  InfoServiceStatus,
  LandoRuntime,
  LandoRuntimeServices,
  LogsAppError,
  LogsAppOptions,
  PullAppError,
  PullAppOptions,
  PushAppError,
  PushAppOptions,
  RebuildAppError,
  RebuildAppOptions,
  RebuildAppResult,
  RemoteSyncError,
  RestartAppError,
  RestartAppOptions,
  RestartAppResult,
  ScratchAcquireError,
  ShareAppError,
  ShareAppOptions,
  ShareStopAppOptions,
  ShareStopAppResult,
  StartAppError,
  StartAppOptions,
  StartAppResult,
  StopAppError,
  StopAppOptions,
  StopAppResult,
  ToolingError,
  ToolingOptions,
  ToolingResult,
} from "@lando/sdk/app";
export { AppResolveError } from "@lando/sdk/errors";
// Re-export the most commonly-used Effect Service tags so consumers get them
// without an extra import (`@lando/core/services` exports the full set).
export {
  AppPlanner,
  CacheService,
  CommandRegistry,
  ConfigService,
  DeprecationService,
  EventService,
  FileSystem,
  LandofileService,
  Logger,
  PluginRegistry,
  PrivilegeService,
  ProcessRunner,
  Renderer,
  RuntimeProvider,
  RuntimeProviderRegistry,
  Telemetry,
} from "@lando/sdk/services";
// App handle convenience API for embedding hosts.
export { resolveApp } from "./app/resolve";
export { openLandoRuntime } from "./app/runtime";
// Runtime factory.
export { type LandoRuntimeOptions, makeLandoRuntime } from "./runtime/layer";
