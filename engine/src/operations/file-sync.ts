import { Effect, Option } from "effect";

import type { AppRef } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";

export const terminateFileSyncSessions = (app: AppRef) =>
  Effect.gen(function* () {
    const maybeEngine = yield* Effect.serviceOption(FileSyncEngine);
    if (Option.isNone(maybeEngine)) return;

    const engine = maybeEngine.value;
    if (!(yield* engine.isAvailable)) return;

    const sessions = yield* engine.listSessions({ app }).pipe(Effect.catchAll(() => Effect.succeed([])));
    for (const session of sessions) {
      yield* engine.terminateSession(session.ref).pipe(Effect.catchAll(() => Effect.void));
    }
  });
