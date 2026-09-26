import { describe, expect, test } from "bun:test";
import type { Context, Effect } from "effect";

import type {
  AppPlanResolutionError,
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
  GpgAgentTransportError,
  GpgAgentUnavailableError,
  HomePathCapabilityError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
  Lando3LandofileDetected,
  LandoCommandError,
  LandofileDialectMixError,
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
  SecretReferenceInvalidError,
  SecretStoreError,
  SecretStoreUnavailableError,
  ShellExecError,
  ShellScriptOutsideRootError,
  SshAgentTransportError,
  SshAgentUnavailableError,
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
  AppPlannerError,
  BuildAppError,
  BuildError,
  BuildOrchestrator,
  LandofileService,
  LandofileServiceError,
  ProviderError,
  ProviderSelectionError,
  RuntimeProviderRegistry,
  SecretStoreShape,
  ShellInteractiveSpec,
  UserLandofileError,
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError
  | SshAgentUnavailableError
  | SshAgentTransportError
  | GpgAgentUnavailableError
  | GpgAgentTransportError
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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
  | Lando3LandofileDetected
  | LandofileDialectMixError
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

describe("SDK named error channels", () => {
  test("secret store and interactive shell preserve typed secret failures", () => {
    // Given: the public secret error union and service shapes.
    // When: extract their failure channels. Then: require exact type equality.
    expect(assertType<Equal<ErrOf<ReturnType<SecretStoreShape["get"]>>, SecretStoreError>>(true)).toBe(true);
    expect(
      assertType<Equal<ErrOf<ReturnType<SecretStoreShape["has"]>>, SecretStoreUnavailableError>>(true),
    ).toBe(true);
    expect(
      assertType<Equal<ErrOf<ReturnType<ShellInteractiveSpec["resolveSecret"]>>, SecretStoreError>>(true),
    ).toBe(true);
  });
  // Given: public aliases and independent legacy channels above.
  // When: compare each alias. Then: require exact equality under tsc.
  test("LandofileServiceError retains the discover members", () => {
    expect(assertType<Equal<LandofileServiceError, LegacyDiscoverChannel>>(true)).toBe(true);
  });

  test("UserLandofileError adds only user-landofile constraints", () => {
    expect(
      assertType<
        Equal<
          UserLandofileError,
          LandofileServiceError | LandofileVersionConstraintError | AppIdReservedError
        >
      >(true),
    ).toBe(true);
  });

  test("ProviderSelectionError contains only selection failures", () => {
    expect(
      assertType<
        Equal<
          ProviderSelectionError,
          NoProviderInstalledError | ProviderConfigError | ProviderUnavailableError
        >
      >(true),
    ).toBe(true);
  });

  test("AppPlannerError retains the planner members", () => {
    expect(assertType<Equal<AppPlannerError, LegacyAppPlannerChannel>>(true)).toBe(true);
  });

  test("BuildError composes event and provider failures", () => {
    expect(assertType<Equal<BuildError, EventError | ProviderSelectionError | ProviderError>>(true)).toBe(
      true,
    );
  });

  test("BuildAppError adds only build-phase failures", () => {
    expect(assertType<Equal<BuildAppError, BuildError | BuildPhaseFailedError>>(true)).toBe(true);
  });

  test("AppPlanResolutionError composes the three resolution channels", () => {
    expect(
      assertType<
        Equal<AppPlanResolutionError, UserLandofileError | ProviderSelectionError | AppPlannerError>
      >(true),
    ).toBe(true);
  });
});
