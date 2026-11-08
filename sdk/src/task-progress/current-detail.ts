import { Context, Effect } from "effect";

import type { TaskTreeController } from "./controller.ts";

/** Receives already-redacted retry detail for the running task in this fiber. */
export const CurrentTaskDetail = Context.Reference<((line: string) => Effect.Effect<void>) | undefined>(
  "@lando/sdk/CurrentTaskDetail",
  { defaultValue: () => undefined },
);

export const withCurrentTaskDetail = <A, E, R>(
  tree: TaskTreeController,
  localId: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let active = true;
    return body.pipe(
      Effect.provideService(CurrentTaskDetail, (line) =>
        Effect.suspend(() => (active ? tree.detail(localId, "stderr", line) : Effect.void)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          active = false;
        }),
      ),
    );
  });
