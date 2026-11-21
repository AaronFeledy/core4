import { isDeepStrictEqual } from "node:util";
import { FileSyncStopError } from "@lando/sdk/errors";
import type { AppRef, FileSyncSessionInfo, FileSyncSessionSpec } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";
import { Effect, Option } from "effect";

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

/** A selected stop already paused or removed this session, and its writers are gone. */
export const isQuiescedAbsentSession = (
  spec: FileSyncSessionSpec,
  sessions: ReadonlyArray<FileSyncSessionInfo>,
  absentServices: ReadonlySet<string>,
): boolean => {
  if (!absentServices.has(String(spec.service))) return false;
  const match = sessions.find((session) => sameFileSyncSessionSpec(spec, session.spec));
  return match === undefined || match.status === "paused";
};

/**
 * Stop coverage for remaining writers. Paused or missing sessions of services whose containers
 * are already gone were quiesced by a selected stop and do not block a later whole-app stop.
 */
export const hasStopFileSyncCoverage = (
  specs: ReadonlyArray<FileSyncSessionSpec>,
  sessions: ReadonlyArray<FileSyncSessionInfo>,
  absentServices: ReadonlySet<string>,
): boolean => {
  const required = specs.filter((spec) => !isQuiescedAbsentSession(spec, sessions, absentServices));
  if (required.length === 0) return true;
  const requiredSessions = sessions.filter((session) =>
    required.some((spec) => sameFileSyncSessionSpec(spec, session.spec)),
  );
  return hasExactFileSyncSessionCoverage(required, requiredSessions);
};

export const sessionsStillRequiringStop = (
  sessions: ReadonlyArray<FileSyncSessionInfo>,
  absentServices: ReadonlySet<string>,
): ReadonlyArray<FileSyncSessionInfo> =>
  sessions.filter((session) => !isQuiescedAbsentSession(session.spec, sessions, absentServices));

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
