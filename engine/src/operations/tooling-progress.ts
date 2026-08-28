import { Effect } from "effect";

import { type ProgressEmitter, makeTaskTree } from "@lando/sdk/task-progress";

const outputLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

export const emitToolingOutputProgress = (input: {
  readonly events: ProgressEmitter | undefined;
  readonly tool: string;
  readonly service: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}): Effect.Effect<void> => {
  const tree = makeTaskTree(input.events, {
    parentId: `tooling:${input.tool}`,
    label: `Tooling: ${input.tool}`,
    children: [{ id: input.service, label: input.service }],
    prefixChildIds: true,
  });
  return Effect.gen(function* () {
    yield* tree.start;
    yield* tree.startTask(input.service);
    for (const line of outputLines(input.stdout)) {
      yield* tree.detail(input.service, "stdout", line);
    }
    for (const line of outputLines(input.stderr)) {
      yield* tree.detail(input.service, "stderr", line);
    }
    if (input.exitCode === 0) {
      yield* tree.completeTask(input.service, "completed with exit code 0", input.durationMs);
    } else {
      yield* tree.failTask(input.service, `failed with exit code ${input.exitCode}`, {
        durationMs: input.durationMs,
        exitCode: input.exitCode,
      });
    }
    yield* tree.close(undefined, input.durationMs);
  });
};

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
    finish: (exitCode: number, durationMs: number) =>
      Effect.gen(function* () {
        if (exitCode === 0) yield* tree.completeTask("exec", undefined, durationMs);
        else yield* tree.failTask("exec", undefined, { durationMs, exitCode });
        yield* tree.close(undefined, durationMs);
      }),
  };
};
