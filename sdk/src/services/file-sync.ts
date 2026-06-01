import { Context, type Effect, type Scope, type Stream } from "effect";

import type { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "../errors/index.ts";
import type {
  FileSyncEngineCapabilities,
  FileSyncEventChunk,
  FileSyncSessionFilter,
  FileSyncSessionInfo,
  FileSyncSessionRef,
  FileSyncSessionSpec,
  FileSyncSetupOptions,
} from "../schema/index.ts";

export type FileSyncError = FileSyncStartError | FileSyncDriftError | FileSyncStopError;

/**
 * FileSyncEngineShape — lifecycle surface every `FileSyncEngine` plugin
 * implements.
 *
 * Engines are session-stateful: one session per accelerated `MountPlan`
 * per started app. `createSession` is `Scope`-acquired so app stop and
 * interruption both flow through the standard finalisation path.
 */
export interface FileSyncEngineShape {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: FileSyncEngineCapabilities;

  readonly isAvailable: Effect.Effect<boolean, FileSyncError>;
  readonly setup: (options: FileSyncSetupOptions) => Effect.Effect<void, FileSyncError, Scope.Scope>;

  readonly createSession: (
    spec: FileSyncSessionSpec,
  ) => Effect.Effect<FileSyncSessionRef, FileSyncError, Scope.Scope>;
  readonly pauseSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
  readonly resumeSession: (ref: FileSyncSessionRef) => Effect.Effect<void, FileSyncError>;
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
