import type { LandoEvent } from "@lando/sdk/services";

type TaskTreeEvent = LandoEvent & { readonly _tag: string };

const isTaskTreeEvent = (event: LandoEvent): boolean =>
  event._tag === "task.tree.start" ||
  event._tag === "task.tree.complete" ||
  event._tag === "task.start" ||
  event._tag === "task.complete" ||
  event._tag === "task.fail" ||
  event._tag === "task.detail";

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const formatDurationSuffix = (durationMs: number | undefined): string => {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return ` (${durationMs}ms)`;
  return ` (${(durationMs / 1000).toFixed(1)}s)`;
};

export const formatPlainEvent = (event: TaskTreeEvent): string | null => {
  switch (event._tag) {
    case "task.tree.start": {
      const label = asString(event.label) ?? "tasks";
      const children = Array.isArray(event.children) ? event.children : [];
      return `▼ ${label} (${children.length} services)`;
    }
    case "task.start": {
      const taskId = asString(event.taskId) ?? "task";
      const label = asString(event.label) ?? taskId;
      return `[${taskId}] start: ${label}`;
    }
    case "task.detail": {
      const taskId = asString(event.taskId) ?? "task";
      const line = asString(event.line) ?? "";
      const stream = asString(event.stream);
      const prefix = stream === "stderr" ? `[${taskId}] !` : `[${taskId}]`;
      return `${prefix} ${line}`;
    }
    case "task.complete": {
      const taskId = asString(event.taskId) ?? "task";
      const summary = asString(event.summary);
      const tail = summary === undefined ? "" : `: ${summary}`;
      return `[${taskId}] ✓ complete${tail}${formatDurationSuffix(asNumber(event.durationMs))}`;
    }
    case "task.fail": {
      const taskId = asString(event.taskId) ?? "task";
      const summary = asString(event.summary);
      const remediation = asString(event.remediation);
      const exitCode = asNumber(event.exitCode);
      const tail = summary === undefined ? "" : `: ${summary}`;
      const exitSuffix = exitCode === undefined ? "" : ` (exit ${exitCode})`;
      const main = `[${taskId}] ✗ fail${tail}${exitSuffix}${formatDurationSuffix(asNumber(event.durationMs))}`;
      return remediation === undefined ? main : `${main}\n[${taskId}]   ↳ ${remediation}`;
    }
    case "task.tree.complete": {
      const summary = asString(event.summary);
      const succeeded = asNumber(event.succeeded) ?? 0;
      const failed = asNumber(event.failed) ?? 0;
      const label = summary ?? "complete";
      return `▶ ${label} (${succeeded} ✓ · ${failed} ✗)${formatDurationSuffix(asNumber(event.durationMs))}`;
    }
    default:
      return null;
  }
};

export const renderPlainLine = (event: LandoEvent): string | null => {
  if (!isTaskTreeEvent(event)) return null;
  return formatPlainEvent(event);
};

const orderedKeys: ReadonlyArray<string> = [
  "_tag",
  "parentId",
  "taskId",
  "label",
  "children",
  "mode",
  "stream",
  "line",
  "summary",
  "succeeded",
  "failed",
  "exitCode",
  "remediation",
  "durationMs",
  "timestamp",
];

const stableStringify = (event: LandoEvent): string => {
  const record = event as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    if (Object.hasOwn(record, key)) result[key] = record[key];
  }
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(result, key)) result[key] = record[key];
  }
  return JSON.stringify(result);
};

export const renderJsonLine = (event: LandoEvent): string | null => {
  if (!isTaskTreeEvent(event)) return null;
  return stableStringify(event);
};

export const isRenderableTaskTreeEvent = isTaskTreeEvent;
