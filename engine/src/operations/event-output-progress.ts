import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";
import { Effect } from "effect";

export const publishEventOutputProgress = Effect.fnUntraced(function* (input: {
  readonly events: ProgressEmitter;
  readonly task: string;
  readonly service: string;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
}) {
  const tree = makeTaskTree(input.events, {
    parentId: `tooling:${input.task}`,
    label: `Event: ${input.task}`,
    children: [{ id: input.service, label: input.service }],
    prefixChildIds: true,
  });
  yield* tree.start;
  yield* tree.startTask(input.service);
  for (const stream of ["stdout", "stderr"] as const) {
    for (const line of input[stream]) yield* tree.detail(input.service, stream, line);
  }
  if (input.exitCode === 0) yield* tree.completeTask(input.service, undefined, input.durationMs);
  else
    yield* tree.failTask(input.service, undefined, {
      durationMs: input.durationMs,
      exitCode: input.exitCode,
    });
  yield* tree.close(undefined, input.durationMs);
});
