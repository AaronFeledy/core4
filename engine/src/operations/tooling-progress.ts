import { Effect } from "effect";

import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";

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
  };
};
