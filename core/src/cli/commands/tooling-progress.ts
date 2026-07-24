import { Effect } from "effect";

import {
  type ProgressEmitter,
  publishTaskComplete,
  publishTaskDetail,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "../progress.ts";

const outputLines = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return [];
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
  const treeId = `tooling:${input.tool}`;
  const taskId = `${treeId}:${input.service}`;
  return Effect.gen(function* () {
    yield* publishTreeStart(input.events, {
      parentId: treeId,
      label: `Tooling: ${input.tool}`,
      children: [taskId],
    });
    yield* publishTaskStart(input.events, {
      taskId,
      parentId: treeId,
      label: input.service,
    });
    for (const line of outputLines(input.stdout)) {
      yield* publishTaskDetail(input.events, { taskId, stream: "stdout", line });
    }
    for (const line of outputLines(input.stderr)) {
      yield* publishTaskDetail(input.events, { taskId, stream: "stderr", line });
    }
    if (input.exitCode === 0) {
      yield* publishTaskComplete(input.events, {
        taskId,
        summary: "completed with exit code 0",
        durationMs: input.durationMs,
      });
      yield* publishTreeComplete(input.events, {
        parentId: treeId,
        succeeded: 1,
        failed: 0,
        durationMs: input.durationMs,
      });
      return;
    }
    yield* publishTaskFail(input.events, {
      taskId,
      summary: `failed with exit code ${input.exitCode}`,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
    });
    yield* publishTreeComplete(input.events, {
      parentId: treeId,
      succeeded: 0,
      failed: 1,
      durationMs: input.durationMs,
    });
  });
};
