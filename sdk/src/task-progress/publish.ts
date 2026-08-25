/**
 * Sync task-tree publishers. Publish failures are swallowed because progress
 * emission is non-essential; the surrounding work must keep running.
 *
 * {@link ProgressEmitter} is a structural subset of `EventService.publish` so
 * callers may inject a real EventService instance or a buffered test stub.
 */
import { DateTime, Effect } from "effect";

import {
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "../events/task.ts";
import type { AbsolutePath } from "../schema/primitives.ts";
import type { EventServiceShape } from "../services/events.ts";

export type ProgressEmitter = Pick<EventServiceShape, "publish">;

const nowUtc = () => DateTime.unsafeMake(new Date().toISOString());

const publishEvent = (
  events: ProgressEmitter | undefined,
  event: Parameters<ProgressEmitter["publish"]>[0],
): Effect.Effect<void> => (events === undefined ? Effect.void : events.publish(event).pipe(Effect.ignore));

export interface TreeStartArgs {
  readonly parentId: string;
  readonly label: string;
  readonly children: ReadonlyArray<string>;
  readonly mode?: "list" | "grid";
}

export const publishTreeStart = (events: ProgressEmitter | undefined, args: TreeStartArgs) =>
  publishEvent(
    events,
    TaskTreeStartEvent.make({
      parentId: args.parentId,
      label: args.label,
      children: args.children,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      timestamp: nowUtc(),
    }),
  );

export interface TaskStartArgs {
  readonly taskId: string;
  readonly parentId?: string;
  readonly label: string;
  readonly transcriptPath?: AbsolutePath;
}

export const publishTaskStart = (events: ProgressEmitter | undefined, args: TaskStartArgs) =>
  publishEvent(
    events,
    TaskStartEvent.make({
      taskId: args.taskId,
      ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
      label: args.label,
      ...(args.transcriptPath === undefined ? {} : { transcriptPath: args.transcriptPath }),
      timestamp: nowUtc(),
    }),
  );

export interface TaskDetailArgs {
  readonly taskId: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

export const publishTaskDetail = (events: ProgressEmitter | undefined, args: TaskDetailArgs) =>
  publishEvent(
    events,
    TaskDetailEvent.make({
      taskId: args.taskId,
      stream: args.stream,
      line: args.line,
      timestamp: nowUtc(),
    }),
  );

export interface TaskCompleteArgs {
  readonly taskId: string;
  readonly summary?: string;
  readonly durationMs?: number;
}

export const publishTaskComplete = (events: ProgressEmitter | undefined, args: TaskCompleteArgs) =>
  publishEvent(
    events,
    TaskCompleteEvent.make({
      taskId: args.taskId,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
      timestamp: nowUtc(),
    }),
  );

export interface TaskFailArgs {
  readonly taskId: string;
  readonly summary?: string;
  readonly exitCode?: number;
  readonly remediation?: string;
  readonly durationMs?: number;
}

export const publishTaskFail = (events: ProgressEmitter | undefined, args: TaskFailArgs) =>
  publishEvent(
    events,
    TaskFailEvent.make({
      taskId: args.taskId,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      ...(args.exitCode === undefined ? {} : { exitCode: args.exitCode }),
      ...(args.remediation === undefined ? {} : { remediation: args.remediation }),
      ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
      timestamp: nowUtc(),
    }),
  );

export interface TreeCompleteArgs {
  readonly parentId: string;
  readonly summary?: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly durationMs?: number;
}

export const publishTreeComplete = (events: ProgressEmitter | undefined, args: TreeCompleteArgs) =>
  publishEvent(
    events,
    TaskTreeCompleteEvent.make({
      parentId: args.parentId,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      succeeded: args.succeeded,
      failed: args.failed,
      ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
      timestamp: nowUtc(),
    }),
  );
