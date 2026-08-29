import { Effect } from "effect";

import type { LandoEvent } from "@lando/sdk/services";

import { styleFrame } from "./task-tree-style.ts";

export const TOOLING_TREE_PREFIX = "tooling:";

const STATUS_INTERVAL_MS = 100;

export const isToolingTreeParentId = (parentId: string): boolean => parentId.startsWith(TOOLING_TREE_PREFIX);

export const toolingNameFromParentId = (parentId: string): string =>
  parentId.slice(TOOLING_TREE_PREFIX.length);

const formatQuietDuration = (durationMs: number): string => {
  if (durationMs < 1000) return `  ${Math.round(durationMs)}ms`;
  return `  ${(durationMs / 1000).toFixed(1)}s`;
};

export const formatToolingStatusLines = (tool: string, elapsedMs: number): ReadonlyArray<string> =>
  styleFrame([`╰─ executing ${tool}${formatQuietDuration(elapsedMs)}`]);

const parentIdOf = (event: LandoEvent): string | undefined => {
  const value = Reflect.get(event, "parentId");
  return typeof value === "string" ? value : undefined;
};

const taskIdOf = (event: LandoEvent): string | undefined => {
  const value = Reflect.get(event, "taskId");
  return typeof value === "string" ? value : undefined;
};

export type ToolingStatusHandle = {
  readonly setFooter: (lines: ReadonlyArray<string>) => void;
  readonly clearFooter: () => void;
};

export type ToolingStatusPainter = {
  readonly consume: (
    event: LandoEvent,
    acquire: Effect.Effect<{ readonly controller: ToolingStatusHandle } | undefined>,
  ) => Effect.Effect<boolean>;
  readonly stop: () => void;
};

export const createToolingStatusPainter = (now: () => number = Date.now): ToolingStatusPainter => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let tool = "";
  let handle: ToolingStatusHandle | undefined;

  const paint = (): void => {
    if (handle === undefined) return;
    handle.setFooter(formatToolingStatusLines(tool, now() - startedAt));
  };

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    handle?.clearFooter();
    handle = undefined;
    tool = "";
  };

  const consume = (
    event: LandoEvent,
    acquire: Effect.Effect<{ readonly controller: ToolingStatusHandle } | undefined>,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const parentId = parentIdOf(event);
      if (event._tag === "task.tree.start" && parentId !== undefined && isToolingTreeParentId(parentId)) {
        const substrate = yield* acquire;
        if (substrate === undefined) return true;
        stop();
        tool = toolingNameFromParentId(parentId);
        handle = substrate.controller;
        startedAt = now();
        paint();
        timer = setInterval(paint, STATUS_INTERVAL_MS);
        return true;
      }
      if (event._tag === "task.tree.complete" && parentId !== undefined && isToolingTreeParentId(parentId)) {
        stop();
        return true;
      }
      if (parentId !== undefined && isToolingTreeParentId(parentId)) return true;
      const taskId = taskIdOf(event);
      if (taskId !== undefined && isToolingTreeParentId(taskId)) return true;
      return false;
    });

  return { consume, stop };
};
