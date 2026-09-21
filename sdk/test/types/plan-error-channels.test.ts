import { describe, expect, test } from "bun:test";
import type { Context, Effect } from "effect";

import type {
  ExecAppError,
  InfoAppError,
  LogsAppError,
  StartAppError,
  StopAppError,
  ToolingError,
} from "@lando/sdk/app";
import type {
  AppIdReservedError,
  AppLockTimeoutError,
  AppResolveError,
  BuildPhaseFailedError,
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  CapabilityError,
  CommandAliasConflictError,
  ComposeKeyRejectedError,
  ConfigError,
  ConfigExpressionError,
  DataTreeOwnershipCapabilityError,
  EventError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  GlobalAutoStartError,
  HomePathCapabilityError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
  LandoCommandError,
  LandofileEventInvocationDepthError,
  LandofileEventLifecycleReentryError,
  LandofileEventStepFailedError,
  LandofileFormConflictError,
  LandofileImportRefMisuseError,
  LandofileIncludeError,
  LandofileLoadExpressionError,
  LandofileLoadLimitError,
  LandofileLoadOutsideRootError,
  LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileUnknownEventError,
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
  PublicationUnsupportedError,
  RouteInputError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
  SecretNotFoundError,
  ShellExecError,
  ShellScriptOutsideRootError,
  StateStoreError,
  ToolingCompileError,
  ToolingDisabledError,
  ToolingExecError,
  ToolingIncludeCycleError,
  ToolingInputError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import type {
  AppPlanner,
  BuildOrchestrator,
  LandofileService,
  ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(value: T): T => value;
type ServiceOf<T> = T extends Context.Tag<infer _Id, infer _Service> ? Context.Tag.Service<T> : never;
type ErrOf<E extends Effect.Effect<unknown, unknown, unknown>> = Effect.Effect.Error<E>;

// allow: SIZE_OK — independent verbatim union fixtures must stay in the requested single SDK test file.
// Given: these member lists are frozen from the pre-refactor contracts, not derived from them.
type LegacyAppPlannerChannel =
  | LandofileValidationError
  | RouteInputError
  | CapabilityError
  | NotImplementedError
  | PublicationUnsupportedError
  | CommandAliasConflictError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | LandofileUnknownEventError;

type LegacyBuildChannel =
  | EventError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type LegacyBuildAppChannel =
  | BuildPhaseFailedError
  | EventError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type LegacyDiscoverChannel =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | RouteInputError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileImportRefMisuseError
  | LandofileLoadLimitError
  | LandofileLoadOutsideRootError
  | ToolingIncludeCycleError
  | NotImplementedError
  | ComposeKeyRejectedError
  | ManagedFileTransactionError;

// The app contract's local LandofileNotFoundError alias includes LandofileFormConflictError.
type LegacyStartAppError =
  | ManagedFileTransactionError
  | AppIdReservedError
  | BuildPhaseFailedError
  | ComposeKeyRejectedError
  | EventError
  | LandofileEventLifecycleReentryError
  | LandofileEventInvocationDepthError
  | LandofileEventStepFailedError
  | ToolingCompileError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileUnknownEventError
  | LandofileIncludeError
  | LandofileLoadExpressionError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NotImplementedError
  | CapabilityError
  | CommandAliasConflictError
  | ConfigExpressionError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | GlobalAutoStartError
  | SecretNotFoundError
  | HostProxySocketStaleError
  | HostProxyTransportUnavailableError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProxyApplyError
  | ProxyError
  | ProxySetupError
  | ProviderUnavailableError
  | RouterPortPinMismatch
  | RouterPortsExhausted
  | RouterWatcherError
  | AppLockTimeoutError
  | StateStoreError
  | VolumeOperationError;

type LegacyStopAppError =
  | ManagedFileTransactionError
  | AppIdReservedError
  | AppResolveError
  | EventError
  | LandofileEventLifecycleReentryError
  | LandofileEventInvocationDepthError
  | LandofileEventStepFailedError
  | ToolingCompileError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileUnknownEventError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NotImplementedError
  | CapabilityError
  | CommandAliasConflictError
  | ConfigExpressionError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | AppLockTimeoutError
  | StateStoreError
  | VolumeOperationError;

type LegacyInfoAppError =
  | ManagedFileTransactionError
  | AppIdReservedError
  | ComposeKeyRejectedError
  | ConfigError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileUnknownEventError
  | LandofileIncludeError
  | LandofileLoadExpressionError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NotImplementedError
  | CapabilityError
  | CommandAliasConflictError
  | ConfigExpressionError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProxyError
  | ProviderUnavailableError;

type LegacyExecAppError =
  | ManagedFileTransactionError
  | AppIdReservedError
  | ComposeKeyRejectedError
  | CapabilityError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | ConfigError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileUnknownEventError
  | LandofileIncludeError
  | LandofileLoadExpressionError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | CommandAliasConflictError
  | ConfigExpressionError
  | ToolingExecError;

type LegacyToolingError =
  | ManagedFileTransactionError
  | AppIdReservedError
  | LandofileEventLifecycleReentryError
  | LandofileEventInvocationDepthError
  | LandofileEventStepFailedError
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | CapabilityError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | ConfigError
  | ComposeKeyRejectedError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileUnknownEventError
  | LandofileIncludeError
  | LandofileLoadExpressionError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ShellExecError
  | ShellScriptOutsideRootError
  | CommandAliasConflictError
  | ConfigExpressionError
  | ToolingCompileError
  | ToolingDisabledError
  | ToolingInputError
  | ToolingExecError;

type LegacyLogsAppError =
  | ManagedFileTransactionError
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileFormConflictError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | RouteInputError
  | LandofileUnknownEventError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | ToolingIncludeCycleError
  | LandofileVersionConstraintError
  | NotImplementedError
  | CapabilityError
  | CommandAliasConflictError
  | ConfigExpressionError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | PublicationUnsupportedError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError;

describe("SDK plan-carrying error channels", () => {
  // When: extract each public channel. Then: require exact member-set equality under tsc.
  test("AppPlanner.plan retains its pre-refactor members", () => {
    assertType<Equal<ErrOf<ReturnType<ServiceOf<typeof AppPlanner>["plan"]>>, LegacyAppPlannerChannel>>(true);
    expect(true).toBe(true);
  });

  test("BuildOrchestrator.build retains its pre-refactor members", () => {
    assertType<Equal<ErrOf<ReturnType<ServiceOf<typeof BuildOrchestrator>["build"]>>, LegacyBuildChannel>>(
      true,
    );
    expect(true).toBe(true);
  });

  test("BuildOrchestrator.buildApp retains its pre-refactor members", () => {
    assertType<
      Equal<ErrOf<ReturnType<ServiceOf<typeof BuildOrchestrator>["buildApp"]>>, LegacyBuildAppChannel>
    >(true);
    expect(true).toBe(true);
  });

  test("LandofileService.discover retains its pre-refactor members", () => {
    assertType<Equal<ErrOf<ServiceOf<typeof LandofileService>["discover"]>, LegacyDiscoverChannel>>(true);
    expect(true).toBe(true);
  });

  test("RuntimeProviderRegistry.capabilities retains its pre-refactor members", () => {
    assertType<
      Equal<
        ErrOf<ServiceOf<typeof RuntimeProviderRegistry>["capabilities"]>,
        NoProviderInstalledError | ProviderConfigError | ProviderUnavailableError
      >
    >(true);
    expect(true).toBe(true);
  });

  test("RuntimeProviderRegistry.select retains its pre-refactor members", () => {
    assertType<
      Equal<
        ErrOf<ReturnType<ServiceOf<typeof RuntimeProviderRegistry>["select"]>>,
        NoProviderInstalledError | ProviderConfigError | ProviderUnavailableError
      >
    >(true);
    expect(true).toBe(true);
  });

  test("StartAppError retains its pre-refactor members", () => {
    assertType<Equal<StartAppError, LegacyStartAppError>>(true);
    expect(true).toBe(true);
  });

  test("StopAppError retains its pre-refactor members", () => {
    assertType<Equal<StopAppError, LegacyStopAppError>>(true);
    expect(true).toBe(true);
  });

  test("InfoAppError retains its pre-refactor members", () => {
    assertType<Equal<InfoAppError, LegacyInfoAppError>>(true);
    expect(true).toBe(true);
  });

  test("ExecAppError retains its pre-refactor members", () => {
    assertType<Equal<ExecAppError, LegacyExecAppError>>(true);
    expect(true).toBe(true);
  });

  test("ToolingError retains its pre-refactor members", () => {
    assertType<Equal<ToolingError, LegacyToolingError>>(true);
    expect(true).toBe(true);
  });

  test("LogsAppError retains its pre-refactor members", () => {
    assertType<Equal<LogsAppError, LegacyLogsAppError>>(true);
    expect(true).toBe(true);
  });
});
