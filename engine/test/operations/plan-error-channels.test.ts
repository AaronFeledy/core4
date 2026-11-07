import { describe, expect, test } from "bun:test";
import type { Effect } from "effect";
import type { loadLandofileLayers } from "../../src/services/landofile-live.ts";

import type { AppPlanResolutionError, RemoteSyncError } from "@lando/sdk/app";
import type {
  AppLockTimeoutError,
  AppPlacementError,
  AppResolveError,
  CapabilityError,
  ConfigExpressionError,
  DataTreeOwnershipCapabilityError,
  DebuggerHostUnavailableError,
  EventError,
  FileSyncSelectionError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  GlobalServiceMissingError,
  HealthcheckTargetUnsupportedError,
  Lando3LandofileDetected,
  LandofileDialectMixError,
  LandofileParseError,
  LandofileValidationError,
  LandofileWriteValidationError,
  ManagedFileTransactionError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
  PublicationUnsupportedError,
  RouteInputError,
  RouteProviderMismatchError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
  ServiceNotReadyError,
  StateStoreError,
  ToolingExecError,
  TunnelProviderUnavailableError,
} from "@lando/sdk/errors";
import type {
  AppPlannerError,
  BuildError,
  FileSystemError,
  ProviderError,
  ProviderSelectionError,
  TunnelError,
  UserLandofileError,
} from "@lando/sdk/services";

import type { loadUserLandofile } from "../../src/landofile/app-resolution.ts";
import type { EnsureGlobalServicesError } from "../../src/operations/ensure-global-services.ts";
import type { globalInstall } from "../../src/operations/global-install.ts";
import type { LoadGlobalPlanError } from "../../src/operations/global-plan.ts";
import type { OrphanTeardownError } from "../../src/operations/orphan-teardown.ts";
import type { RemoteSyncCommandError } from "../../src/operations/remote.ts";
import type { ShareListCommandError } from "../../src/operations/share.ts";
import type { planApp } from "../../src/planner/assemble.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(value: T): T => value;
type ErrOf<E extends Effect.Effect<unknown, unknown, unknown>> = Effect.Error<E>;
type LandofileRootLoadError = Effect.Error<ReturnType<typeof loadLandofileLayers>>;

// Given: independent member lists for the intended operation contracts.
type ExpectedLoadGlobalPlanError =
  | GlobalServiceCollisionError
  | PluginManifestError
  | HealthcheckTargetUnsupportedError
  | FileSyncSelectionError
  | RouteProviderMismatchError
  | AppPlacementError
  | LandofileRootLoadError
  | CapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError
  | LandofileValidationError
  | RouteInputError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | PublicationUnsupportedError
  | ProviderUnavailableError;

type LegacyPlanAppChannel =
  | HealthcheckTargetUnsupportedError
  | FileSyncSelectionError
  | RouteProviderMismatchError
  | LandofileValidationError
  | RouteInputError
  | CapabilityError
  | DataTreeOwnershipCapabilityError
  | NotImplementedError
  | PublicationUnsupportedError
  | ConfigExpressionError;

type LegacyOrphanTeardownError =
  | AppResolveError
  | ProviderError
  | ProviderUnavailableError
  | ProviderConfigError
  | NoProviderInstalledError
  | AppLockTimeoutError
  | StateStoreError;

type ExpectedGlobalInstallError =
  | Exclude<LandofileRootLoadError, LandofileValidationError>
  | LandofileWriteValidationError
  | ManagedFileTransactionError
  | AppPlacementError
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | NoProviderInstalledError
  | PluginManifestError
  | ProviderConfigError
  | ProviderUnavailableError;

type ExpectedEnsureGlobalServicesError =
  | AppResolveError
  | DebuggerHostUnavailableError
  | StateStoreError
  | LandofileWriteValidationError
  | ManagedFileTransactionError
  | FileSyncSelectionError
  | RouteProviderMismatchError
  | AppPlacementError
  | LandofileRootLoadError
  | ServiceNotReadyError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | CapabilityError
  | PublicationUnsupportedError
  | EventError
  | FileSystemError
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | GlobalServiceMissingError
  | LandofileParseError
  | LandofileValidationError
  | RouteInputError
  | NoProviderInstalledError
  | NotImplementedError
  | PluginManifestError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | SecretNotFoundError
  | SecretStoreUnavailableError
  | SecretReferenceInvalidError
  | ToolingExecError;

type LegacyRemoteSyncCommandError =
  | HealthcheckTargetUnsupportedError
  | FileSyncSelectionError
  | RouteProviderMismatchError
  | RemoteSyncError
  | UserLandofileError
  | CapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderUnavailableError
  | PublicationUnsupportedError;

type LegacyShareListCommandError =
  | HealthcheckTargetUnsupportedError
  | FileSyncSelectionError
  | RouteProviderMismatchError
  | UserLandofileError
  | CapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderUnavailableError
  | PublicationUnsupportedError
  | TunnelError
  | TunnelProviderUnavailableError
  | StateStoreError;

describe("Engine plan-carrying error channels", () => {
  test("preserves dialect failures in user loading without adding them to planning", () => {
    // Given
    type DialectError = Lando3LandofileDetected | LandofileDialectMixError;
    // When / Then
    expect(
      assertType<Equal<Extract<ErrOf<ReturnType<typeof loadUserLandofile>>, DialectError>, DialectError>>(
        true,
      ),
    ).toBe(true);
    expect(assertType<Equal<Extract<AppPlannerError, DialectError>, never>>(true)).toBe(true);
  });
  // When: extract each operation channel. Then: require exact member-set equality under tsc.
  test("LoadGlobalPlanError carries shared Landofile compilation and planning failures", () => {
    assertType<Equal<LoadGlobalPlanError, ExpectedLoadGlobalPlanError>>(true);
    assertType<
      Equal<
        LoadGlobalPlanError,
        | AppPlannerError
        | LandofileRootLoadError
        | ProviderSelectionError
        | FileSystemError
        | GlobalAppError
        | AppPlacementError
        | LandofileParseError
        | GlobalServiceCollisionError
        | PluginManifestError
      >
    >(true);
    expect(true).toBe(true);
  });

  test("planApp retains its pre-refactor error members", () => {
    assertType<Equal<ErrOf<ReturnType<typeof planApp>>, LegacyPlanAppChannel>>(true);
    assertType<Equal<ErrOf<ReturnType<typeof planApp>>, AppPlannerError>>(true);
    expect(true).toBe(true);
  });

  test("OrphanTeardownError retains its pre-refactor members", () => {
    assertType<Equal<OrphanTeardownError, LegacyOrphanTeardownError>>(true);
    assertType<
      Equal<
        OrphanTeardownError,
        AppResolveError | ProviderError | ProviderSelectionError | AppLockTimeoutError | StateStoreError
      >
    >(true);
    expect(true).toBe(true);
  });

  test("globalInstall carries prepared compilation and publication failures", () => {
    assertType<Equal<ErrOf<ReturnType<typeof globalInstall>>, ExpectedGlobalInstallError>>(true);
    expect(true).toBe(true);
  });

  test("EnsureGlobalServicesError carries global loading, build, and readiness failures", () => {
    assertType<Equal<EnsureGlobalServicesError, ExpectedEnsureGlobalServicesError>>(true);
    assertType<
      Equal<
        EnsureGlobalServicesError,
        | DebuggerHostUnavailableError
        | ServiceNotReadyError
        | LoadGlobalPlanError
        | BuildError
        | GlobalDistConflictError
        | GlobalLandofilePathConflictError
        | GlobalServiceCollisionError
        | GlobalServiceMissingError
        | PluginManifestError
        | SecretNotFoundError
        | SecretStoreUnavailableError
        | SecretReferenceInvalidError
        | ToolingExecError
        | Effect.Error<ReturnType<typeof globalInstall>>
        | AppResolveError
        | StateStoreError
      >
    >(true);
    expect(true).toBe(true);
  });

  test("RemoteSyncCommandError retains its pre-refactor members", () => {
    assertType<Equal<RemoteSyncCommandError, LegacyRemoteSyncCommandError>>(true);
    assertType<Equal<RemoteSyncCommandError, RemoteSyncError | AppPlanResolutionError>>(true);
    expect(true).toBe(true);
  });

  test("ShareListCommandError retains its pre-refactor members", () => {
    assertType<Equal<ShareListCommandError, LegacyShareListCommandError>>(true);
    assertType<
      Equal<
        ShareListCommandError,
        AppPlanResolutionError | TunnelError | TunnelProviderUnavailableError | StateStoreError
      >
    >(true);
    expect(true).toBe(true);
  });
});
