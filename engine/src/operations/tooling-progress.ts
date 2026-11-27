import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";
import { Cause, Clock, Effect, Exit } from "effect";

/** Publish a tooling task tree (no per-line body detail) when an event publisher exists. */
export const beginLiveToolingTree = (events: ProgressEmitter | undefined, tool: string) => {
  const tree = makeTaskTree(events, {
    parentId: `tooling:${tool}`,
    label: tool,
    children: [{ id: "exec", label: "executing" }],
    prefixChildIds: true,
  });
  return {
    start: Effect.gen(function* () {
      yield* tree.start;
      yield* tree.startTask("exec");
    }),
    finish: Effect.fnUntraced(function* (exitCode: number, durationMs: number) {
      if (exitCode === 0) yield* tree.completeTask("exec", undefined, durationMs);
      else yield* tree.failTask("exec", undefined, { durationMs, exitCode });
      yield* tree.close(undefined, durationMs);
    }),
    fail: (cause: Cause.Cause<unknown>, durationMs: number) =>
      Cause.hasInterruptsOnly(cause)
        ? tree.settleInterrupt("interrupted", durationMs)
        : tree.settleFailure("failed", durationMs),
  };
};

export const withLiveToolingTree = Effect.fnUntraced(function* <
  A extends { readonly exitCode: number },
  E,
  R,
>(work: Effect.Effect<A, E, R>, events: ProgressEmitter | undefined, tool: string) {
  if (events === undefined) return yield* work;
  const tree = beginLiveToolingTree(events, tool);
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* tree.start.pipe(
    Effect.andThen(work),
    Effect.onExit((exit) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((finishedAt) => {
          const durationMs = finishedAt - startedAt;
          return Exit.isSuccess(exit)
            ? tree.finish(exit.value.exitCode, durationMs)
            : tree.fail(exit.cause, durationMs);
        }),
      ),
    ),
  );
});
