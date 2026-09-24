import { Context, type Effect, type Scope } from "effect";

import type {
  GlobalAppError,
  GlobalDistConflictError,
  GlobalLandofilePathConflictError,
} from "../errors/index.ts";
import type { AbsolutePath, PortNumber, ServiceConfig, ServiceName } from "../schema/index.ts";

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
    /** Make the global service provider reachable before probing provider-host ports. */
    readonly ensureProviderReady?: Effect.Effect<void, GlobalAppError>;
    readonly paths: Effect.Effect<GlobalAppPaths, GlobalAppError>;
    readonly ensureUserLandofile: Effect.Effect<
      { readonly path: AbsolutePath; readonly created: boolean },
      GlobalAppError | GlobalLandofilePathConflictError
    >;
    /** Restart an existing running global service so it reloads externally stored configuration. */
    readonly restartRunningService?: (service: ServiceName) => Effect.Effect<boolean, GlobalAppError>;
    readonly ensureRunning: (services: ReadonlyArray<string>) => Effect.Effect<
      ReadonlyArray<{
        readonly name: string;
        readonly state: string;
        readonly endpoints: ReadonlyArray<string>;
      }>,
      GlobalAppError
    >;
    /** Read-only provider-host TCP occupancy for published port candidates. */
    readonly occupiedPublishPorts?: (
      ports: ReadonlyArray<PortNumber>,
    ) => Effect.Effect<ReadonlyArray<PortNumber>, GlobalAppError>;
    /** Published TCP ports held by running Lando global services. */
    readonly ownedPublishPorts?: (
      service: ServiceName,
      ports: ReadonlyArray<PortNumber>,
    ) => Effect.Effect<ReadonlyArray<PortNumber>, GlobalAppError>;
    readonly regenerateDist: (input?: { readonly services?: Record<string, ServiceConfig> }) => Effect.Effect<
      GlobalDistResult,
      GlobalAppError | GlobalDistConflictError
    >;
  }
>() {}
