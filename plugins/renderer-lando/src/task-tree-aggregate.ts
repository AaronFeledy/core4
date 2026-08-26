import { occurrenceTaskId } from "./task-tree-occurrence.ts";
import type { TaskState, TaskTreeRenderState, TreeState } from "./task-tree-render.ts";

export type AggregateTreeInput = {
  readonly parentId: string;
  readonly state: TaskTreeRenderState;
};

export const aggregateRenderState = (
  commandId: string,
  trees: ReadonlyArray<AggregateTreeInput>,
): TaskTreeRenderState => {
  const tasks = new Map<string, TaskState>();
  const order: string[] = [];
  const spinningTaskIds = new Set<string>();
  let spinnerFrame = 0;
  let spinnerLocked = false;
  let succeeded = 0;
  let failed = 0;
  let durationMs: number | undefined;
  let allDone = trees.length > 0;
  let expandedTaskId: string | undefined;
  let expandedLines: ReadonlyArray<string> = [];
  let terminalColumns: number | undefined;

  for (const { parentId, state } of trees) {
    terminalColumns = state.terminalColumns ?? terminalColumns;
    if (!spinnerLocked && state.spinningTaskIds.size > 0) {
      spinnerFrame = state.spinnerFrame;
      spinnerLocked = true;
    }
    if (state.tree === undefined || !state.tree.done) allDone = false;
    if (state.tree !== undefined) {
      succeeded += state.tree.succeeded;
      failed += state.tree.failed;
      if (state.tree.durationMs !== undefined) durationMs = (durationMs ?? 0) + state.tree.durationMs;
    }
    for (const id of state.order) {
      const task = state.tasks.get(id);
      if (task === undefined) continue;
      const syntheticId = occurrenceTaskId(parentId, id);
      order.push(syntheticId);
      tasks.set(syntheticId, { ...task, id: syntheticId });
    }
    for (const id of state.spinningTaskIds) spinningTaskIds.add(occurrenceTaskId(parentId, id));
    if (state.expandedTaskId !== undefined) {
      expandedTaskId = occurrenceTaskId(parentId, state.expandedTaskId);
      expandedLines = state.expandedLines;
    }
  }

  const tree: TreeState = {
    parentId: "session",
    childCount: order.length,
    label: commandId,
    done: allDone,
    summary: commandId,
    succeeded,
    failed,
    durationMs,
  };

  return {
    tree,
    tasks,
    order,
    spinningTaskIds,
    spinnerFrame,
    expandedTaskId,
    expandedLines,
    terminalColumns,
  };
};
