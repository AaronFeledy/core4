import { Context, type Effect, Schema, type Scope } from "effect";

import type {
  AppPlacementError,
  DebuggerHostUnavailableError,
  LandofileVersionConstraintError,
  RouteUrlBindingError,
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
} from "../errors/index.ts";
import {
  type AbsolutePath,
  type AppRef,
  type IsolateMode,
  ProxyAuthority,
  ServiceName,
} from "../schema/index.ts";

export interface ScratchAppPaths {
  readonly base: AbsolutePath;
  readonly instanceRoot: AbsolutePath;
  readonly root: AbsolutePath;
  readonly planCache: AbsolutePath;
}

export type ScratchSource = { readonly kind: "fork" } | { readonly kind: "recipe"; readonly ref: string };

export type ScratchAcquireSource =
  | {
      readonly kind: "fork";
      /** Existing directory to discover from. Relative paths resolve against the runtime's cwd. */
      readonly path?: string;
    }
  | Extract<ScratchSource, { readonly kind: "recipe" }>;

/**
 * Opt-in to mounting the host current working directory ($PWD) into the
 * scratch app's primary service. Presence of this object enables the mount;
 * `target` overrides the container mount point (defaults to the primary
 * service's appMount destination, or `/app`).
 */
export interface ScratchMountCwd {
  readonly target?: string;
}

type ScratchAcquireIsolationMode = IsolateMode | "none";

export interface ScratchAcquireInput {
  readonly source: ScratchAcquireSource;
  readonly detached: boolean;
  readonly name?: string;
  readonly answers?: Record<string, string>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  /** Isolation mode; legacy `none` is accepted as an input alias for `cwd`. */
  readonly isolate?: ScratchAcquireIsolationMode;
  /** Mount $PWD into the scratch app's primary service (`--mount-cwd`). */
  readonly mountCwd?: ScratchMountCwd;
  /**
   * Join the shared cross-app network and expose the global app's storage
   * scope (`--share-global-storage`). Explicit opt-in; never inferred.
   */
  readonly shareGlobalStorage?: boolean;
  readonly excludes?: ReadonlyArray<string>;
  readonly keepOnFailure?: boolean;
  readonly runPostInit?: boolean;
  readonly noLocalOverrides?: boolean;
  readonly noHostnameSuffix?: boolean;
  readonly hostnames?: ReadonlyArray<string>;
}

export interface ScratchHandle {
  readonly id: string;
  readonly app: AppRef;
  readonly credentialChanges?: NonNullable<
    import("../schema/app-results.ts").StartAppResult["credentialChanges"]
  >;
}

/**
 * Lifetime status of a scratch app, derived from its registry entry:
 * - `attached`  — a foreground scratch whose owning CLI process is still alive.
 * - `detached`  — a `--detach` scratch that outlives the command that created it.
 * - `orphan`    — a foreground scratch whose owning process exited without
 *                 cleaning up (a reap candidate for `apps:scratch:gc`).
 */
export type ScratchLifetimeStatus = "attached" | "detached" | "orphan";

export interface ScratchSummary {
  readonly id: string;
  readonly app: AppRef;
  /** Whether the scratch app came from a fork or a recipe. */
  readonly source: ScratchSource;
  /** Isolation mode the scratch app was started in (`full` | `baked` | `cwd`). */
  readonly mode: IsolateMode;
  /** ISO 8601 timestamp the scratch app was first registered. */
  readonly created: string;
  /** Lifetime status (`attached` | `detached` | `orphan`). */
  readonly status: ScratchLifetimeStatus;
}

/** A single mount surfaced by `apps:scratch:info`. */
export interface ScratchMountPoint {
  /** Service the mount is attached to. */
  readonly service: string;
  /** Container mount point. */
  readonly target: string;
  /** Host path or volume name (omitted for `tmpfs`). */
  readonly source?: string;
  /** Mount kind: the app mount, a generic bind/volume/tmpfs mount. */
  readonly kind: "app" | "bind" | "tmpfs" | "volume";
  /** Whether the mount is read-only. */
  readonly readOnly: boolean;
}

/** Network membership surfaced by `apps:scratch:info`. */
export interface ScratchNetworkMembership {
  /** Per-app bridge network name (when planned). */
  readonly perAppBridge?: string;
  /** Shared cross-app network name (present only when joined). */
  readonly sharedNetwork?: string;
}

/** Per-service endpoint listing surfaced by `apps:scratch:info`. */
export interface ScratchServiceEndpoints {
  readonly service: string;
  readonly endpoints: ReadonlyArray<{
    readonly protocol: string;
    readonly port?: number;
    readonly name?: string;
  }>;
}

export const ScratchPublishedRoute = Schema.Struct({
  ...ProxyAuthority.fields,
  service: ServiceName.annotate({ description: "Scratch service receiving requests to this URL." }),
  url: Schema.String.annotate({
    description: "Published route URL, including any nonstandard port and path prefix.",
  }),
});
export type ScratchPublishedRoute = typeof ScratchPublishedRoute.Type;

/**
 * Full scratch inspection: summary, cached mount/network/endpoint details,
 * and, when the scratch declares enabled routes, the routes the router confirms.
 */
export interface ScratchInfo extends ScratchSummary {
  readonly mounts: ReadonlyArray<ScratchMountPoint>;
  readonly network: ScratchNetworkMembership;
  readonly endpoints: ReadonlyArray<ScratchServiceEndpoints>;
  readonly routes?: ReadonlyArray<ScratchPublishedRoute>;
}

export interface ScratchStartOptions {
  readonly detach?: boolean;
}

export interface ScratchDestroyOptions {
  readonly keepVolumes?: boolean;
  /** Poweroff may reap a discovered scratch whose registry entry is gone. */
  readonly reason?: "explicit" | "poweroff";
}

export interface ScratchGcOptions {
  readonly prune?: boolean;
}

export interface ScratchGcReport {
  readonly inspected: number;
  /** Ids GC treats as orphaned: what a report-only run would prune, or what `--prune` tried to reap. */
  readonly candidates: ReadonlyArray<string>;
  readonly reaped: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export class ScratchAppService extends Context.Service<
  ScratchAppService,
  {
    readonly kind: "scratch";
    readonly root: Effect.Effect<AbsolutePath, ScratchAppError>;
    readonly ensureRoot: Effect.Effect<AbsolutePath, ScratchAppError, Scope.Scope>;
    readonly synthesizeId: (base: string) => Effect.Effect<string, ScratchAppError>;
    readonly paths: (id: string) => Effect.Effect<ScratchAppPaths, ScratchAppError>;
    readonly acquire: (
      input: ScratchAcquireInput,
    ) => Effect.Effect<
      ScratchHandle,
      | ScratchSourceUnresolvedError
      | ScratchIsolationConflictError
      | ScratchAppError
      | RouteUrlBindingError
      | AppPlacementError
      | DebuggerHostUnavailableError
      | LandofileVersionConstraintError,
      Scope.Scope
    >;
    readonly resolveById: (
      id: string,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly info: (id: string) => Effect.Effect<ScratchInfo, ScratchAppNotFoundError | ScratchAppError>;
    readonly list: () => Effect.Effect<ReadonlyArray<ScratchSummary>, ScratchAppError>;
    readonly start: (
      id: string,
      options?: ScratchStartOptions,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError | RouteUrlBindingError>;
    readonly stop: (id: string) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly destroy: (
      id: string,
      options?: ScratchDestroyOptions,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly gc: (options?: ScratchGcOptions) => Effect.Effect<ScratchGcReport, ScratchAppError>;
  }
>()("@lando/core/ScratchAppService") {}
