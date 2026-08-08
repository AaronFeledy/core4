/**
 * Task-tree progress helpers for the CLI commands.
 *
 * Each long-running command (setup/start/init) publishes a `task.tree.start`
 * with the set of child task ids, then `task.start` / `task.complete` /
 * `task.fail` per child, then `task.tree.complete` with succeeded/failed
 * counts. Publish failures are swallowed because progress emission is
 * non-essential; the surrounding work must keep running.
 *
 * The `ProgressEmitter` shape is a structural subset of `EventService` so
 * callers may inject a real `EventService` instance or a buffered test stub.
 */
import { type Context, DateTime, Effect } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

export type ProgressEmitter = Pick<Context.Tag.Service<typeof EventService>, "publish">;

const nowUtc = () => DateTime.unsafeMake(new Date().toISOString());

const publishEvent = (events: ProgressEmitter | undefined, event: LandoEvent): Effect.Effect<void> =>
  events === undefined ? Effect.void : events.publish(event).pipe(Effect.ignore);

const publishEventAsync = async (events: ProgressEmitter | undefined, event: LandoEvent): Promise<void> => {
  if (events === undefined) return;
  await Effect.runPromiseExit(events.publish(event));
};

export interface TreeStartArgs {
  readonly parentId: string;
  readonly label: string;
  readonly children: ReadonlyArray<string>;
  readonly mode?: "list" | "grid";
}

const buildTreeStart = (args: TreeStartArgs): TaskTreeStartEvent =>
  TaskTreeStartEvent.make({
    parentId: args.parentId,
    label: args.label,
    children: args.children,
    ...(args.mode === undefined ? {} : { mode: args.mode }),
    timestamp: nowUtc(),
  });

export const publishTreeStart = (events: ProgressEmitter | undefined, args: TreeStartArgs) =>
  publishEvent(events, buildTreeStart(args));

export const publishTreeStartAsync = (events: ProgressEmitter | undefined, args: TreeStartArgs) =>
  publishEventAsync(events, buildTreeStart(args));

export interface TaskStartArgs {
  readonly taskId: string;
  readonly parentId?: string;
  readonly label: string;
  readonly transcriptPath?: AbsolutePath;
}

const buildTaskStart = (args: TaskStartArgs): TaskStartEvent =>
  TaskStartEvent.make({
    taskId: args.taskId,
    ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
    label: args.label,
    ...(args.transcriptPath === undefined ? {} : { transcriptPath: args.transcriptPath }),
    timestamp: nowUtc(),
  });

export const publishTaskStart = (events: ProgressEmitter | undefined, args: TaskStartArgs) =>
  publishEvent(events, buildTaskStart(args));

export const publishTaskStartAsync = (events: ProgressEmitter | undefined, args: TaskStartArgs) =>
  publishEventAsync(events, buildTaskStart(args));

export interface TaskDetailArgs {
  readonly taskId: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

const buildTaskDetail = (args: TaskDetailArgs): TaskDetailEvent =>
  TaskDetailEvent.make({
    taskId: args.taskId,
    stream: args.stream,
    line: args.line,
    timestamp: nowUtc(),
  });

export const publishTaskDetail = (events: ProgressEmitter | undefined, args: TaskDetailArgs) =>
  publishEvent(events, buildTaskDetail(args));

export const publishTaskDetailAsync = (events: ProgressEmitter | undefined, args: TaskDetailArgs) =>
  publishEventAsync(events, buildTaskDetail(args));

export interface TaskCompleteArgs {
  readonly taskId: string;
  readonly summary?: string;
  readonly durationMs?: number;
}

const buildTaskComplete = (args: TaskCompleteArgs): TaskCompleteEvent =>
  TaskCompleteEvent.make({
    taskId: args.taskId,
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
    timestamp: nowUtc(),
  });

export const publishTaskComplete = (events: ProgressEmitter | undefined, args: TaskCompleteArgs) =>
  publishEvent(events, buildTaskComplete(args));

export const publishTaskCompleteAsync = (events: ProgressEmitter | undefined, args: TaskCompleteArgs) =>
  publishEventAsync(events, buildTaskComplete(args));

export interface TaskFailArgs {
  readonly taskId: string;
  readonly summary?: string;
  readonly exitCode?: number;
  readonly remediation?: string;
  readonly durationMs?: number;
}

const buildTaskFail = (args: TaskFailArgs): TaskFailEvent =>
  TaskFailEvent.make({
    taskId: args.taskId,
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.exitCode === undefined ? {} : { exitCode: args.exitCode }),
    ...(args.remediation === undefined ? {} : { remediation: args.remediation }),
    ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
    timestamp: nowUtc(),
  });

export const publishTaskFail = (events: ProgressEmitter | undefined, args: TaskFailArgs) =>
  publishEvent(events, buildTaskFail(args));

export const publishTaskFailAsync = (events: ProgressEmitter | undefined, args: TaskFailArgs) =>
  publishEventAsync(events, buildTaskFail(args));

export interface TreeCompleteArgs {
  readonly parentId: string;
  readonly summary?: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly durationMs?: number;
}

const buildTreeComplete = (args: TreeCompleteArgs): TaskTreeCompleteEvent =>
  TaskTreeCompleteEvent.make({
    parentId: args.parentId,
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    succeeded: args.succeeded,
    failed: args.failed,
    ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
    timestamp: nowUtc(),
  });

export const publishTreeComplete = (events: ProgressEmitter | undefined, args: TreeCompleteArgs) =>
  publishEvent(events, buildTreeComplete(args));

export const publishTreeCompleteAsync = (events: ProgressEmitter | undefined, args: TreeCompleteArgs) =>
  publishEventAsync(events, buildTreeComplete(args));
