import { isDeepStrictEqual } from "node:util";
import { Effect, Option } from "effect";

import { FileSyncStopError } from "@lando/sdk/errors";
import type { AppRef, FileSyncSessionInfo, FileSyncSessionSpec } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";

/** Prove every saved accelerated mount has exactly one live session before stopping writers. */
export const hasExactFileSyncSessionCoverage = (
  specs: ReadonlyArray<FileSyncSessionSpec>,
  sessions: ReadonlyArray<FileSyncSessionInfo>,
): boolean => {
  if (specs.length === 0 || specs.length !== sessions.length) return false;
  const unmatched = [...sessions];
  for (const spec of specs) {
    const index = unmatched.findIndex((session) => isDeepStrictEqual(session.spec, spec));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
};
export const terminateFileSyncSessions = (app: AppRef, expected?: ReadonlyArray<FileSyncSessionInfo>) =>
  Effect.gen(function* () {
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

    const sessions = yield* engine.listSessions({ app });
    if (
      expected !== undefined &&
      (sessions.length !== expected.length ||
        expected.some(
          (prior) =>
            !sessions.some(
              (current) => current.ref === prior.ref && isDeepStrictEqual(current.spec, prior.spec),
            ),
        ))
    ) {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: engine.id,
          sessionRef: String(expected[0]?.ref ?? app.id),
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
