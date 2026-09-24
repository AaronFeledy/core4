import { Context, type Effect, type Scope, type Stream } from "effect";

import type { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "../errors/index.ts";
import type {
  AppPlan,
  AppRef,
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionFilter,
  FileSyncSessionInfo,
  FileSyncSessionRef,
  FileSyncSessionSpec,
  FileSyncSetupOptions,
  PreparedFileSyncTarget,
} from "../schema/index.ts";

export type FileSyncError = FileSyncStartError | FileSyncDriftError | FileSyncStopError;

/**
 * FileSyncEngineShape — lifecycle surface every `FileSyncEngine` plugin
 * implements.
 *
 * Engines are session-stateful: one session per accelerated `MountPlan`
 * per started app. Ephemeral `createSession` acquisitions finalize with
 * their scope. Engines with process-persistent sessions keep successful
 * sessions across handle closure; startup failure compensates new sessions.
 */
export interface FileSyncEngineShape {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: FileSyncEngineCapabilities;
  /** Existing sessions survive process exit and must not be tied to an AppHandle scope. */
  readonly sessionsPersistAcrossProcesses?: boolean;

  /**
   * Optional durable app lifecycle. Engines with process-persistent sessions
   * use this to keep a drained app restartable and to retain disposal
   * receipts until provider cleanup has succeeded.
   */
  readonly appLifecycle?: {
    readonly invalidateDrain: (app: AppRef) => Effect.Effect<void, FileSyncStartError>;
    readonly drain: (app: AppRef) => Effect.Effect<void, FileSyncStopError>;
    readonly dispose: (app: AppRef) => Effect.Effect<void, FileSyncStopError>;
    readonly completeDisposal: (app: AppRef) => Effect.Effect<void, FileSyncStopError>;
  };

  /**
   * Optional app-scoped handoff after the provider's complete prepared target
   * set has been validated. Binding may inspect the host but must not mutate
   * external or durable resources; failure or interruption can only release
   * provider-prepared targets. Return a separate engine without mutating this
   * shared service; only the returned engine may create this app's sessions.
   */
  readonly bindPreparedTargets?: (
    plan: AppPlan,
    targets: ReadonlyArray<PreparedFileSyncTarget>,
  ) => Effect.Effect<FileSyncEngineShape, FileSyncStartError>;

  readonly isAvailable: Effect.Effect<boolean, FileSyncError>;
  readonly setup: (options: FileSyncSetupOptions) => Effect.Effect<void, FileSyncError, Scope.Scope>;

  readonly createSession: (
    spec: FileSyncSessionSpec,
  ) => Effect.Effect<FileSyncSessionRef, FileSyncError, Scope.Scope>;
  readonly pauseSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
  readonly resumeSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
  /** Block until all pending changes reach the session target or fail. */
  readonly flushSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
  readonly terminateSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;

  readonly listSessions: (
    filter: FileSyncSessionFilter,
  ) => Effect.Effect<ReadonlyArray<FileSyncSessionInfo>, FileSyncError>;
  readonly streamEvents: (ref: FileSyncSessionRef) => Stream.Stream<FileSyncEventChunk, FileSyncError>;
}

/**
 * FileSyncEngine — pluggable accelerated bind-mount engine. Default
 * implementation is the no-op `passthrough`; the bundled default for
 * `bindMountPerformance: "slow"` providers is `@lando/file-sync-mutagen`.
 */
export class FileSyncEngine extends Context.Tag("@lando/core/FileSyncEngine")<
  FileSyncEngine,
  FileSyncEngineShape
>() {}
