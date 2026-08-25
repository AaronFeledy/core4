import { Effect } from "effect";

import type { AbsolutePath } from "../schema/primitives.ts";
import {
  type ProgressEmitter,
  publishTaskComplete,
  publishTaskDetail,
  publishTaskFail,
  publishTaskStart,
  publishTreeComplete,
  publishTreeStart,
} from "./publish.ts";

export const startChildTaskId = (parentId: string, localId: string): string => `${parentId}:${localId}`;

export interface TaskSpec {
  readonly id: string;
  readonly label: string;
}

export interface TaskTreeSummaries {
  readonly success: string;
  readonly failure: string;
  readonly interrupt: string;
}

export interface TaskStartOptions {
  readonly transcriptPath?: AbsolutePath;
}

export interface TaskFailOptions {
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly remediation?: string;
}

export interface TaskTreeController {
  readonly parentId: string;
  readonly childId: (localId: string) => string;
  readonly start: Effect.Effect<void>;
  readonly startTask: (localId: string, options?: TaskStartOptions) => Effect.Effect<void>;
  readonly completeTask: (localId: string, summary?: string, durationMs?: number) => Effect.Effect<void>;
  readonly failTask: (localId: string, summary?: string, options?: TaskFailOptions) => Effect.Effect<void>;
  readonly detail: (localId: string, stream: "stdout" | "stderr", line: string) => Effect.Effect<void>;
  readonly settleSuccess: (summary: string, durationMs?: number) => Effect.Effect<void>;
  readonly settleFailure: (summary: string, durationMs?: number) => Effect.Effect<void>;
  readonly settleInterrupt: (summary: string, durationMs?: number) => Effect.Effect<void>;
  readonly close: (summary?: string, durationMs?: number) => Effect.Effect<void>;
}

export interface MakeTaskTreeArgs {
  readonly parentId: string;
  readonly label: string;
  readonly children: ReadonlyArray<TaskSpec>;
  readonly mode?: "list" | "grid";
  readonly prefixChildIds?: boolean;
  readonly now?: () => number;
}

const elapsedMs = (startedAt: number, now: number): number => Math.round(now - startedAt);

export const makeTaskTree = (
  events: ProgressEmitter | undefined,
  args: MakeTaskTreeArgs,
): TaskTreeController => {
  const nowFn = args.now ?? (() => performance.now());
  const prefix = args.prefixChildIds === true;
  const childId = (localId: string): string => (prefix ? startChildTaskId(args.parentId, localId) : localId);
  const labels = new Map(args.children.map((child) => [child.id, child.label]));
  const started = new Set<string>();
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  const childStartedAt = new Map<string, number>();
  let treeStartedAt = nowFn();
  let opened = false;
  let closed = false;

  const settleChild = (
    localId: string,
    outcome: "complete" | "fail",
    summary?: string,
    options?: TaskFailOptions,
  ): Effect.Effect<void> => {
    if (succeeded.has(localId) || failed.has(localId)) return Effect.void;
    const taskId = childId(localId);
    const origin = childStartedAt.get(localId) ?? treeStartedAt;
    const durationMs = options?.durationMs ?? elapsedMs(origin, nowFn());
    switch (outcome) {
      case "complete":
        succeeded.add(localId);
        return publishTaskComplete(events, {
          taskId,
          ...(summary === undefined ? {} : { summary }),
          durationMs,
        });
      case "fail":
        failed.add(localId);
        return publishTaskFail(events, {
          taskId,
          ...(summary === undefined ? {} : { summary }),
          ...(options?.exitCode === undefined ? {} : { exitCode: options.exitCode }),
          ...(options?.remediation === undefined ? {} : { remediation: options.remediation }),
          durationMs,
        });
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  };

  const startDeclared = (localId: string, options?: TaskStartOptions): Effect.Effect<void> => {
    if (started.has(localId)) return Effect.void;
    started.add(localId);
    childStartedAt.set(localId, nowFn());
    return publishTaskStart(events, {
      taskId: childId(localId),
      parentId: args.parentId,
      label: labels.get(localId) ?? localId,
      ...(options?.transcriptPath === undefined ? {} : { transcriptPath: options.transcriptPath }),
    });
  };

  const closeTree = (summary?: string, durationMs?: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!opened || closed) return Effect.void;
      closed = true;
      return publishTreeComplete(events, {
        parentId: args.parentId,
        ...(summary === undefined ? {} : { summary }),
        succeeded: succeeded.size,
        failed: failed.size,
        durationMs: durationMs ?? elapsedMs(treeStartedAt, nowFn()),
      });
    });

  const settleRemaining = (outcome: "complete" | "fail", summary?: string): Effect.Effect<void> =>
    Effect.forEach(
      args.children,
      (child) =>
        Effect.gen(function* () {
          if (succeeded.has(child.id) || failed.has(child.id)) return;
          if (!started.has(child.id)) yield* startDeclared(child.id);
          yield* settleChild(child.id, outcome, summary);
        }),
      { discard: true },
    );

  return {
    parentId: args.parentId,
    childId,
    start: Effect.sync(() => {
      opened = true;
      treeStartedAt = nowFn();
    }).pipe(
      Effect.zipRight(
        publishTreeStart(events, {
          parentId: args.parentId,
          label: args.label,
          children: args.children.map((child) => childId(child.id)),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        }),
      ),
    ),
    startTask: startDeclared,
    completeTask: (localId, summary, durationMs) =>
      settleChild(localId, "complete", summary, durationMs === undefined ? undefined : { durationMs }),
    failTask: (localId, summary, options) => settleChild(localId, "fail", summary, options),
    detail: (localId, stream, line) => publishTaskDetail(events, { taskId: childId(localId), stream, line }),
    settleSuccess: (summary, durationMs) =>
      settleRemaining("complete").pipe(Effect.zipRight(closeTree(summary, durationMs))),
    settleFailure: (summary, durationMs) =>
      settleRemaining("fail", summary).pipe(Effect.zipRight(closeTree(summary, durationMs))),
    settleInterrupt: (summary, durationMs) =>
      settleRemaining("fail", summary).pipe(Effect.zipRight(closeTree(summary, durationMs))),
    close: closeTree,
  };
};

export const runWithTaskTree = <A, E, R>(
  tree: TaskTreeController,
  work: (tree: TaskTreeController) => Effect.Effect<A, E, R>,
  summaries: TaskTreeSummaries,
): Effect.Effect<A, E, R> =>
  tree.start.pipe(
    Effect.zipRight(work(tree)),
    Effect.tap(() => tree.settleSuccess(summaries.success)),
    Effect.tapError(() => tree.settleFailure(summaries.failure)),
    Effect.onInterrupt(() => tree.settleInterrupt(summaries.interrupt)),
  );
