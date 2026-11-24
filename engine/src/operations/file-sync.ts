import { isDeepStrictEqual } from "node:util";
import { FileSyncStopError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, FileSyncSessionInfo, FileSyncSessionSpec } from "@lando/sdk/schema";
import { FileSyncEngine, type FileSyncEngineShape, type RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Option } from "effect";

import { acquireFileSyncEngine } from "./file-sync-acquire.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";

/** Prove every saved accelerated mount has exactly one live session before stopping writers. */
export const hasExactFileSyncSessionCoverage = (
  specs: ReadonlyArray<FileSyncSessionSpec>,
  sessions: ReadonlyArray<FileSyncSessionInfo>,
): boolean => {
  if (specs.length === 0 || specs.length !== sessions.length) return false;
  const unmatched = [...sessions];
  for (const spec of specs) {
    const index = unmatched.findIndex((session) => sameFileSyncSessionSpec(spec, session.spec));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
};

/** A selected stop paused this session after removing its service's container. */
const isQuiescedSession = (session: FileSyncSessionInfo, absentServices: ReadonlySet<string>): boolean =>
  session.status === "paused" && absentServices.has(String(session.spec.service));

/**
 * Stop coverage: every listed session belongs to exactly one saved mount and no mount has two.
 * A mount of a service with no active container may have no session left, because a selected
 * stop already terminated it; every other mount needs its session.
 */
export const hasStopFileSyncCoverage = (
  specs: ReadonlyArray<FileSyncSessionSpec>,
  sessions: ReadonlyArray<FileSyncSessionInfo>,
  absentServices: ReadonlySet<string>,
): boolean => {
  if (specs.length === 0) return false;
  const unmatched = [...sessions];
  for (const spec of specs) {
    const matches = unmatched.filter((session) => sameFileSyncSessionSpec(spec, session.spec));
    if (matches.length > 1) return false;
    const match = matches[0];
    if (match === undefined) {
      if (!absentServices.has(String(spec.service))) return false;
      continue;
    }
    unmatched.splice(unmatched.indexOf(match), 1);
  }
  return unmatched.length === 0;
};

/** Sessions a stop still has to flush and stop: everything a selected stop has not quiesced. */
const sessionsStillRequiringStop = (
  sessions: ReadonlyArray<FileSyncSessionInfo>,
  absentServices: ReadonlySet<string>,
): ReadonlyArray<FileSyncSessionInfo> =>
  sessions.filter((session) => !isQuiescedSession(session, absentServices));

export const terminateFileSyncSessions = Effect.fnUntraced(function* (
  app: AppRef,
  expected?: ReadonlyArray<FileSyncSessionInfo>,
  absentServices: ReadonlySet<string> = new Set(),
) {
  const maybeEngine = yield* Effect.serviceOption(FileSyncEngine);
  if (Option.isNone(maybeEngine)) {
    if (expected === undefined) return;
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: "unavailable",
        sessionRef: String(expected[0]?.ref ?? app.id),
        message: "The file sync engine disappeared before its final flush.",
        remediation: "Restore the file sync engine and retry after checking the session state.",
      }),
    );
  }

  const engine = maybeEngine.value;
  if (!(yield* engine.isAvailable)) {
    if (expected === undefined) return;
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: engine.id,
        sessionRef: String(expected[0]?.ref ?? app.id),
        message: "The file sync engine became unavailable before its final flush.",
        remediation: "Restore the file sync engine and retry after checking the session state.",
      }),
    );
  }

  const listed = yield* engine.listSessions({ app });
  const sessions = sessionsStillRequiringStop(listed, absentServices);
  const comparableExpected =
    expected === undefined ? undefined : sessionsStillRequiringStop(expected, absentServices);
  if (
    comparableExpected !== undefined &&
    (sessions.length !== comparableExpected.length ||
      comparableExpected.some(
        (prior) =>
          !sessions.some(
            (current) => current.ref === prior.ref && isDeepStrictEqual(current.spec, prior.spec),
          ),
      ))
  ) {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: engine.id,
        sessionRef: String(comparableExpected[0]?.ref ?? app.id),
        message: "File sync sessions changed while app writers were stopping.",
        remediation: "Inspect and repair the file sync sessions before retrying destroy.",
      }),
    );
  }
  for (const session of sessions) {
    if (session.status !== "running") {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: engine.id,
          sessionRef: String(session.ref),
          message: `Cannot safely stop a file sync session that is ${session.status}.`,
          remediation: "Repair or resume the file sync session, then retry the command.",
        }),
      );
    }
    yield* engine.flushSession(session.ref);
  }
  for (const session of sessions) {
    yield* engine.terminateSession(session.ref);
  }
});

type SelectedFileSync = {
  readonly engine: FileSyncEngineShape | undefined;
  readonly sessions: ReadonlyArray<FileSyncSessionInfo>;
};

const noSelectedFileSync: SelectedFileSync = { engine: undefined, sessions: [] };

/**
 * Verify the selected services' saved file sync while every writer is still in place: state that
 * cannot be verified, a missing engine, a missing, duplicate, or unknown session, and a session
 * that is not running all fail before any container is removed.
 */
export const preflightSelectedStopFileSync = Effect.fnUntraced(function* (
  plan: AppPlan,
  ref: AppRef,
  selected: ReadonlySet<string>,
  absentServices: ReadonlySet<string>,
  provider: RuntimeProviderShape,
) {
  if (provider.inspectAppliedFileSync === undefined) return noSelectedFileSync;
  const applied = yield* provider.inspectAppliedFileSync(plan);
  if (applied.status === "unknown") {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: "unavailable",
        sessionRef: String(plan.id),
        message: "Previous file sync state could not be verified; stopping may leave unsynchronized changes.",
        remediation: "Inspect and repair the file sync session and provider state, then retry stop.",
      }),
    );
  }
  if (applied.status !== "accelerated") return noSelectedFileSync;
  const selectedSpecs = applied.sessions.filter((session) => selected.has(String(session.service)));
  if (selectedSpecs.length === 0) return noSelectedFileSync;
  const maybeEngine = yield* acquireFileSyncEngine(applied.engineId).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
  const engine = Option.getOrUndefined(maybeEngine);
  const engineAvailable = engine !== undefined && (yield* engine.isAvailable);
  const sessions = engineAvailable ? yield* engine.listSessions({ app: ref }) : [];
  const selectedSessions = sessions.filter((session) => selected.has(String(session.service)));
  if (
    engine === undefined ||
    !engineAvailable ||
    !hasStopFileSyncCoverage(selectedSpecs, selectedSessions, absentServices)
  ) {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: applied.engineId,
        sessionRef: String(selectedSessions[0]?.ref ?? plan.id),
        message: "An accelerated mount has no matching active file sync session.",
        remediation: "Inspect and repair the file sync session and provider state, then retry stop.",
      }),
    );
  }
  const toQuiesce = sessionsStillRequiringStop(selectedSessions, absentServices);
  const unhealthy = toQuiesce.find((session) => session.status !== "running");
  if (unhealthy !== undefined) {
    return yield* Effect.fail(
      new FileSyncStopError({
        engineId: engine.id,
        sessionRef: String(unhealthy.ref),
        message: `Cannot safely stop a file sync session that is ${unhealthy.status}.`,
        remediation: "Repair or resume the file sync session, then retry the command.",
      }),
    );
  }
  return { engine, sessions: toQuiesce };
});

/**
 * Flush after the writers are gone so their last writes reach the project, then pause the
 * sessions on a durable engine, which the next start resumes, or terminate them otherwise.
 */
export const quiesceSelectedStopFileSync = Effect.fnUntraced(function* ({
  engine,
  sessions,
}: SelectedFileSync) {
  if (engine === undefined) return;
  for (const session of sessions) yield* engine.flushSession(session.ref);
  for (const session of sessions) {
    if (engine.appLifecycle === undefined) yield* engine.terminateSession(session.ref);
    else yield* engine.pauseSession(session.ref);
  }
});
