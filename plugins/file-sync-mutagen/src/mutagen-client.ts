/**
 * `MutagenClient` is the narrow transport surface consumed by the
 * file-sync-mutagen `FileSyncEngine`. The concrete implementation will
 * spawn the installed Mutagen host CLI. The bundled engine still defaults
 * to the unavailable client until the provider can guarantee a populated
 * target volume before starting application containers.
 */

import { DateTime, Effect, Stream } from "effect";

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import type {
  AppRef,
  FileSyncEventChunk,
  FileSyncSessionInfo,
  FileSyncSessionSpec,
  FileSyncSessionStatus,
} from "@lando/sdk/schema";

const ENGINE_ID = "mutagen" as const;
const UNAVAILABLE_CLIENT_REMEDIATION =
  "Continue with ordinary mounts; this build does not include a live Mutagen session client.";

/**
 * Snapshot of a Mutagen session as reported by the daemon. The fields
 * map 1:1 onto a `FileSyncSessionInfo`; the engine attaches the
 * structured app/service identity (which the daemon does not retain) at
 * the engine layer.
 */
export interface MutagenSessionRecord {
  readonly name: string;
  readonly status: FileSyncSessionStatus;
  readonly lastUpdatedAt: DateTime.Utc;
  readonly spec: FileSyncSessionSpec;
  readonly detail?: string;
}

/** Argument shape for `MutagenClient.create`. */
export interface MutagenCreateArgs {
  readonly name: string;
  readonly spec: FileSyncSessionSpec;
}

/**
 * Effect-typed transport the engine calls. Methods correspond to the
 * Mutagen `Synchronization` gRPC surface:
 *
 *   - `version`   — `Daemon.Version`
 *   - `create`    — `Synchronization.Create`
 *   - `pause`     — `Synchronization.Pause`
 *   - `resume`    — `Synchronization.Resume`
 *   - `terminate` — `Synchronization.Terminate`
 *   - `list`      — `Synchronization.List`
 *   - `streamEvents` — `Synchronization.Monitor`
 *
 * Errors stay typed as the SDK trio (`FileSyncStartError`,
 * `FileSyncDriftError`, `FileSyncStopError`) so the engine can re-emit
 * them without re-tagging.
 */
export interface MutagenClient {
  /** Durable sessions survive the command scope and require explicit app lifecycle cleanup. */
  readonly persistsAcrossProcesses?: boolean;
  readonly invalidateAppDrain?: (app: AppRef) => Effect.Effect<void, FileSyncStartError>;
  readonly drainApp?: (app: AppRef) => Effect.Effect<void, FileSyncStopError>;
  readonly disposeApp?: (app: AppRef) => Effect.Effect<void, FileSyncStopError>;
  readonly completeAppDisposal?: (app: AppRef) => Effect.Effect<void, FileSyncStopError>;
  readonly version: Effect.Effect<string, FileSyncStartError>;
  readonly create: (args: MutagenCreateArgs) => Effect.Effect<void, FileSyncStartError>;
  /** Block until an inspected, conflict-free synchronization cycle completes. */
  readonly flush: (name: string) => Effect.Effect<void, FileSyncStartError>;
  readonly pause: (name: string) => Effect.Effect<void, FileSyncStopError>;
  readonly resume: (name: string) => Effect.Effect<void, FileSyncStartError>;
  readonly terminate: (name: string) => Effect.Effect<void, FileSyncStopError>;
  readonly list: Effect.Effect<ReadonlyArray<MutagenSessionRecord>, FileSyncStartError>;
  readonly streamEvents: (
    name: string,
  ) => Stream.Stream<FileSyncEventChunk, FileSyncDriftError | FileSyncStartError>;
}

const unavailableStart = (message: string, spec?: FileSyncSessionSpec): FileSyncStartError =>
  new FileSyncStartError({
    engineId: ENGINE_ID,
    message,
    ...(spec === undefined ? {} : { sessionSpec: spec }),
    remediation: UNAVAILABLE_CLIENT_REMEDIATION,
  });

const unavailableStop = (message: string, sessionRef: string): FileSyncStopError =>
  new FileSyncStopError({
    engineId: ENGINE_ID,
    sessionRef,
    message,
    remediation: UNAVAILABLE_CLIENT_REMEDIATION,
  });

/**
 * Default client used by the bundled Live Layer until a live Mutagen
 * session adapter ships. Provisioned binaries alone do not make it available.
 */
export const makeUnavailableMutagenClient = (
  reason = "This build has no live Mutagen session client.",
): MutagenClient => ({
  version: Effect.fail(unavailableStart(reason)),
  create: (args) => Effect.fail(unavailableStart(reason, args.spec)),
  flush: () => Effect.fail(unavailableStart(reason)),
  pause: (name) => Effect.fail(unavailableStop(reason, name)),
  resume: () => Effect.fail(unavailableStart(reason)),
  terminate: (name) => Effect.fail(unavailableStop(reason, name)),
  list: Effect.fail(unavailableStart(reason)),
  streamEvents: () => Stream.fail(unavailableStart(reason)),
});

/** Sentinel patterns honored by the in-memory fake so unit tests can
 *  drive the documented SDK contract negative paths without forking
 *  the engine logic. */
const REJECT_MOUNT_KEY = "__REJECT__";
const CONFLICT_REF = "__CONFLICT__";
const STOP_FAIL_REF = "__STOP_FAIL__";

/** Sentinel session-ref forms exposed for callers (tests) that need
 *  to address the documented sentinel paths through the engine. */
export const MUTAGEN_FAKE_SENTINELS = {
  rejectMountKey: REJECT_MOUNT_KEY,
  conflictRef: CONFLICT_REF,
  stopFailRef: STOP_FAIL_REF,
} as const;

/** Observable state exposed by `makeFakeMutagenClient` for assertions. */
export interface FakeMutagenClientState {
  /** Sessions keyed by Mutagen session name. */
  readonly sessions: ReadonlyMap<string, MutagenSessionRecord>;
  /** Lifecycle calls recorded in invocation order. */
  readonly calls: ReadonlyArray<
    | { readonly op: "version" }
    | { readonly op: "create"; readonly name: string; readonly spec: FileSyncSessionSpec }
    | { readonly op: "flush"; readonly name: string }
    | { readonly op: "pause"; readonly name: string }
    | { readonly op: "resume"; readonly name: string }
    | { readonly op: "terminate"; readonly name: string }
    | { readonly op: "list" }
    | { readonly op: "streamEvents"; readonly name: string }
  >;
}

/** Fake client returned by `makeFakeMutagenClient`. Exposes the
 *  underlying state and recorded call log alongside the standard
 *  `MutagenClient` surface. */
export interface FakeMutagenClient extends MutagenClient {
  readonly state: FakeMutagenClientState;
  /** Force an existing session into the `errored` status (for status
   *  polling tests). */
  readonly markErrored: (name: string, detail: string) => void;
}

const fakeNow = (): DateTime.Utc => DateTime.unsafeMake("2026-05-28T00:00:00Z");

/**
 * In-memory `MutagenClient` used by unit tests and the SDK contract
 * runner.
 *
 * Sentinel behaviors (honored to keep parity with `TestFileSyncEngine`
 * in `@lando/sdk/test`):
 *
 *   - `create({ spec: { mountKey: "__REJECT__" }, ... })` → `FileSyncStartError`
 *   - `streamEvents("__CONFLICT__")` → `FileSyncDriftError`
 *   - `terminate("__STOP_FAIL__")` → `FileSyncStopError`
 */
export const makeFakeMutagenClient = (
  options: {
    readonly version?: string;
    readonly initialSessions?: ReadonlyArray<MutagenSessionRecord>;
  } = {},
): FakeMutagenClient => {
  const sessions = new Map<string, MutagenSessionRecord>(
    options.initialSessions?.map((record) => [record.name, record]) ?? [],
  );
  const calls: FakeMutagenClientState["calls"] = [];
  const recordCall = (entry: FakeMutagenClientState["calls"][number]) =>
    (calls as Array<FakeMutagenClientState["calls"][number]>).push(entry);

  const reportedVersion = options.version ?? "0.18.3";

  const client: FakeMutagenClient = {
    state: { sessions, calls },
    markErrored(name, detail) {
      const current = sessions.get(name);
      if (current === undefined) return;
      sessions.set(name, { ...current, status: "errored", detail, lastUpdatedAt: fakeNow() });
    },
    version: Effect.sync(() => {
      recordCall({ op: "version" });
      return reportedVersion;
    }),
    create: (args) =>
      Effect.suspend(() => {
        recordCall({ op: "create", name: args.name, spec: args.spec });
        if (args.spec.mountKey === REJECT_MOUNT_KEY) {
          return Effect.fail(
            new FileSyncStartError({
              engineId: ENGINE_ID,
              message: "Fake Mutagen rejected the __REJECT__ sentinel.",
              sessionSpec: args.spec,
            }),
          );
        }
        sessions.set(args.name, {
          name: args.name,
          status: "running",
          lastUpdatedAt: fakeNow(),
          spec: args.spec,
        });
        return Effect.void;
      }),
    flush: (name) =>
      Effect.sync(() => {
        recordCall({ op: "flush", name });
      }),
    pause: (name) =>
      Effect.sync(() => {
        recordCall({ op: "pause", name });
        const current = sessions.get(name);
        if (current === undefined) return;
        sessions.set(name, { ...current, status: "paused", lastUpdatedAt: fakeNow() });
      }),
    resume: (name) =>
      Effect.sync(() => {
        recordCall({ op: "resume", name });
        const current = sessions.get(name);
        if (current === undefined) return;
        sessions.set(name, { ...current, status: "running", lastUpdatedAt: fakeNow() });
      }),
    terminate: (name) =>
      Effect.suspend(() => {
        recordCall({ op: "terminate", name });
        if (name === STOP_FAIL_REF) {
          return Effect.fail(
            new FileSyncStopError({
              engineId: ENGINE_ID,
              sessionRef: name,
              message: "Fake Mutagen rejected the __STOP_FAIL__ sentinel.",
            }),
          );
        }
        sessions.delete(name);
        return Effect.void;
      }),
    list: Effect.sync(() => {
      recordCall({ op: "list" });
      return Array.from(sessions.values());
    }),
    streamEvents: (name) =>
      Stream.suspend(() => {
        recordCall({ op: "streamEvents", name });
        if (name === CONFLICT_REF) {
          return Stream.fail(
            new FileSyncDriftError({
              engineId: ENGINE_ID,
              sessionRef: name,
              conflictedPaths: ["README.md"],
              message: "Fake Mutagen drift sentinel triggered.",
              suggestedMode: "two-way-resolved",
            }),
          );
        }
        const info: FileSyncEventChunk = { _tag: "info", sessionRef: name as never, message: "ready" };
        return Stream.make(info);
      }),
  };

  return client;
};

/**
 * Translate a `MutagenSessionRecord` into the SDK
 * `FileSyncSessionInfo` shape the engine exposes through `listSessions`.
 */
export const toFileSyncSessionInfo = (record: MutagenSessionRecord): FileSyncSessionInfo => ({
  ref: record.name as never,
  app: record.spec.app,
  service: record.spec.service,
  mountKey: record.spec.mountKey,
  spec: record.spec,
  status: record.status,
  lastUpdatedAt: record.lastUpdatedAt,
  ...(record.detail === undefined ? {} : { detail: record.detail }),
});
