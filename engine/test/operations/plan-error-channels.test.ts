import { describe, expect, test } from "bun:test";
import type { Effect } from "effect";

import type { AppPlanResolutionError, RemoteSyncError } from "@lando/sdk/app";
import type {
  AppLockTimeoutError,
  CapabilityError,
  CommandAliasConflictError,
  ConfigExpressionError,
  DataTreeOwnershipCapabilityError,
  EventError,
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
  GlobalServiceCollisionError,
  GlobalServiceMissingError,
  HomePathCapabilityError,
  LandofileParseError,
  LandofileUnknownEventError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  PluginManifestError,
  ProviderConfigError,
  ProviderUnavailableError,
  PublicationUnsupportedError,
  RouteInputError,
  SecretNotFoundError,
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

import type { EnsureGlobalServicesError } from "../../src/operations/ensure-global-services.ts";
import type { globalInstall } from "../../src/operations/global-install.ts";
import type { LoadGlobalPlanError } from "../../src/operations/global-plan.ts";
import type { OrphanTeardownError } from "../../src/operations/orphan-teardown.ts";
import type { RemoteSyncCommandError } from "../../src/operations/remote.ts";
import type { ShareListCommandError } from "../../src/operations/share.ts";
import type { planApp } from "../../src/planner/assemble.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(value: T): T => value;
type ErrOf<E extends Effect.Effect<unknown, unknown, unknown>> = Effect.Effect.Error<E>;

// Given: independent member lists copied from the pre-refactor operation contracts.
type LegacyLoadGlobalPlanError =
  | CapabilityError
  | CommandAliasConflictError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError
  | LandofileUnknownEventError
  | LandofileValidationError
  | RouteInputError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | PublicationUnsupportedError
  | ProviderUnavailableError;

type LegacyPlanAppChannel =
  | LandofileValidationError
  | RouteInputError
  | CapabilityError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | NotImplementedError
  | PublicationUnsupportedError
  | CommandAliasConflictError
  | ConfigExpressionError
  | LandofileUnknownEventError;

type LegacyOrphanTeardownError =
  | ProviderError
  | ProviderUnavailableError
  | ProviderConfigError
  | NoProviderInstalledError
  | AppLockTimeoutError
  | StateStoreError;

type LegacyGlobalInstallChannel =
  | GlobalAppError
  | GlobalDistConflictError
  | GlobalLandofilePathConflictError
  | GlobalServiceCollisionError
  | NoProviderInstalledError
  | PluginManifestError
  | ProviderConfigError
  | ProviderUnavailableError;

type LegacyEnsureGlobalServicesError =
  | CommandAliasConflictError
  | HomePathCapabilityError
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
  | LandofileUnknownEventError
  | LandofileValidationError
  | RouteInputError
  | NoProviderInstalledError
  | NotImplementedError
  | PluginManifestError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | SecretNotFoundError
  | ToolingExecError;

type LegacyRemoteSyncCommandError =
  | RemoteSyncError
  | UserLandofileError
  | LandofileUnknownEventError
  | CapabilityError
  | CommandAliasConflictError
  | HomePathCapabilityError
  | DataTreeOwnershipCapabilityError
  | ConfigExpressionError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderUnavailableError
  | PublicationUnsupportedError;

type LegacyShareListCommandError =
  | UserLandofileError
  | LandofileUnknownEventError
  | CapabilityError
  | CommandAliasConflictError
  | HomePathCapabilityError
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
  // When: extract each operation channel. Then: require exact member-set equality under tsc.
  test("LoadGlobalPlanError retains its pre-refactor members", () => {
    assertType<Equal<LoadGlobalPlanError, LegacyLoadGlobalPlanError>>(true);
    assertType<
      Equal<
        LoadGlobalPlanError,
        AppPlannerError | ProviderSelectionError | FileSystemError | GlobalAppError | LandofileParseError
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
        ProviderError | ProviderSelectionError | AppLockTimeoutError | StateStoreError
      >
    >(true);
    expect(true).toBe(true);
  });

  test("globalInstall retains its pre-refactor error members", () => {
    assertType<Equal<ErrOf<ReturnType<typeof globalInstall>>, LegacyGlobalInstallChannel>>(true);
    expect(true).toBe(true);
  });

  test("EnsureGlobalServicesError retains its pre-refactor members", () => {
    assertType<Equal<EnsureGlobalServicesError, LegacyEnsureGlobalServicesError>>(true);
    assertType<
      Equal<
        EnsureGlobalServicesError,
        | LoadGlobalPlanError
        | BuildError
        | GlobalDistConflictError
        | GlobalLandofilePathConflictError
        | GlobalServiceCollisionError
        | GlobalServiceMissingError
        | PluginManifestError
        | SecretNotFoundError
        | ToolingExecError
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
