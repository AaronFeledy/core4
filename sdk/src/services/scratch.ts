import { Context, type Effect, type Scope } from "effect";

import type {
  ScratchAppError,
  ScratchAppNotFoundError,
  ScratchIsolationConflictError,
  ScratchSourceUnresolvedError,
} from "../errors/index.ts";
import type { AbsolutePath, AppRef, IsolateMode } from "../schema/index.ts";

export interface ScratchAppPaths {
  readonly base: AbsolutePath;
  readonly instanceRoot: AbsolutePath;
  readonly root: AbsolutePath;
  readonly planCache: AbsolutePath;
  readonly infoCache: AbsolutePath;
  readonly buildResults: AbsolutePath;
}

export type ScratchSource = { readonly kind: "fork" } | { readonly kind: "recipe"; readonly ref: string };

/**
 * Opt-in to mounting the host current working directory ($PWD) into the
 * scratch app's primary service. Presence of this object enables the mount;
 * `target` overrides the container mount point (defaults to the primary
 * service's appMount destination, or `/app`).
 */
export interface ScratchMountCwd {
  readonly target?: string;
}

export interface ScratchAcquireInput {
  readonly source: ScratchSource;
  readonly detached: boolean;
  readonly name?: string;
  readonly answers?: Record<string, string>;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly isolate?: IsolateMode;
  /** Mount $PWD into the scratch app's primary service (`--mount-cwd`). */
  readonly mountCwd?: ScratchMountCwd;
  /**
   * Join the shared cross-app network and expose the global app's storage
   * scope (`--share-global-storage`). Explicit opt-in; never inferred.
   */
  readonly shareGlobalStorage?: boolean;
}

export interface ScratchHandle {
  readonly id: string;
  readonly app: AppRef;
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
  /** Where the scratch app came from — a fork of the cwd app or a recipe. */
  readonly source: ScratchSource;
  /** Isolation mode the scratch app was started in (`none` | `full`). */
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

/**
 * Full inspection of a single scratch app: the same fields as a
 * `ScratchSummary` plus the realized mount points, network membership, and
 * per-service endpoints read from the cached plan.
 */
export interface ScratchInfo extends ScratchSummary {
  readonly mounts: ReadonlyArray<ScratchMountPoint>;
  readonly network: ScratchNetworkMembership;
  readonly endpoints: ReadonlyArray<ScratchServiceEndpoints>;
}

export interface ScratchStartOptions {
  readonly detach?: boolean;
}

export interface ScratchDestroyOptions {
  readonly keepVolumes?: boolean;
}

export interface ScratchGcOptions {
  readonly prune?: boolean;
}

export interface ScratchGcReport {
  readonly inspected: number;
  readonly reaped: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export class ScratchAppService extends Context.Tag("@lando/core/ScratchAppService")<
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
      ScratchSourceUnresolvedError | ScratchIsolationConflictError | ScratchAppError,
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
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly stop: (id: string) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly destroy: (
      id: string,
      options?: ScratchDestroyOptions,
    ) => Effect.Effect<ScratchHandle, ScratchAppNotFoundError | ScratchAppError>;
    readonly gc: (options?: ScratchGcOptions) => Effect.Effect<ScratchGcReport, ScratchAppError>;
  }
>() {}
