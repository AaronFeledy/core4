import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";
import { Effect } from "effect";

// Lifecycle cmd diagnostics remain redacted narration; named tooling never enters this presenter.
export const publishEventCmdProgress = Effect.fnUntraced(function* (input: {
  readonly events: ProgressEmitter;
  readonly task: string;
  readonly service: string;
  readonly stdout: string;
  readonly stderr: string;
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
    const lines = input[stream].split(/\r?\n/u);
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) yield* tree.detail(input.service, stream, line);
  }
  if (input.exitCode === 0) yield* tree.completeTask(input.service, undefined, input.durationMs);
  else
    yield* tree.failTask(input.service, undefined, {
      durationMs: input.durationMs,
      exitCode: input.exitCode,
    });
  yield* tree.close(undefined, input.durationMs);
});
