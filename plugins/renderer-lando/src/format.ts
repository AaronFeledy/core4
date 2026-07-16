import type { LandoEvent } from "@lando/sdk/services";

type RenderableEvent = LandoEvent & { readonly _tag: string };

const isTaskTreeEvent = (event: LandoEvent): boolean =>
  event._tag === "task.tree.start" ||
  event._tag === "task.tree.complete" ||
  event._tag === "task.start" ||
  event._tag === "task.complete" ||
  event._tag === "task.fail" ||
  event._tag === "task.detail";

const isMessageEvent = (event: LandoEvent): boolean =>
  event._tag === "message.info" || event._tag === "message.warn" || event._tag === "message.error";

const isPaintBannerEvent = (event: LandoEvent): boolean => event._tag === "paint.banner";
const isImagePullProgressEvent = (event: LandoEvent): boolean => event._tag === "image-pull-progress";

const isRenderableEvent = (event: LandoEvent): boolean =>
  isTaskTreeEvent(event) ||
  isMessageEvent(event) ||
  isPaintBannerEvent(event) ||
  isImagePullProgressEvent(event);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export const formatDurationSuffix = (durationMs: number | undefined): string => {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return ` (${durationMs}ms)`;
  return ` (${(durationMs / 1000).toFixed(1)}s)`;
};

export const formatPlainEvent = (event: RenderableEvent): string | null => {
  switch (event._tag) {
    case "message.info": {
      const body = asString(event.body) ?? "";
      return `ℹ ${body}`;
    }
    case "message.warn": {
      const body = asString(event.body) ?? "";
      return `⚠ ${body}`;
    }
    case "message.error": {
      const body = asString(event.body) ?? "";
      const remediation = asString(event.remediation);
      const main = `✗ ${body}`;
      return remediation === undefined ? main : `${main}\n  ↳ ${remediation}`;
    }
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
    case "paint.banner": {
      return null;
    }
    case "image-pull-progress": {
      const reference = asString(event.reference) ?? "image";
      const stream = asString(event.stream);
      const current = asNumber(event.current);
      const total = asNumber(event.total);
      const message = stream === undefined ? "" : `: ${stream}`;
      const progress = current === undefined ? "" : ` (${current}${total === undefined ? "" : `/${total}`})`;
      return `↓ Pulling ${reference}${message}${progress}`;
    }
    default:
      return null;
  }
};

export const renderPlainLine = (event: LandoEvent): string | null => {
  const record = event as unknown as Record<string, unknown>;
  if (record._tag === "log.line") {
    return asString(record.line) ?? asString(record.message) ?? "";
  }
  if (!isRenderableEvent(event)) return null;
  return formatPlainEvent(event);
};

const orderedKeys: ReadonlyArray<string> = [
  "_tag",
  "parentId",
  "taskId",
  "label",
  "children",
  "mode",
  "reference",
  "stream",
  "current",
  "total",
  "line",
  "body",
  "banner",
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

const stablePayload = (event: LandoEvent): Record<string, unknown> => JSON.parse(stableStringify(event));

export const renderJsonLine = (event: LandoEvent): string | null => {
  if (!isRenderableEvent(event)) return null;
  return JSON.stringify({ _tag: "event", event: event._tag, payload: stablePayload(event) });
};

/**
 * Verbose line: the human-readable head plus a full payload trace of every
 * event — including events `plain` does not surface (e.g. `log.line`).
 */
export const renderVerboseLine = (event: LandoEvent): string => {
  const payload = stableStringify(event);
  const human = formatPlainEvent(event as RenderableEvent);
  if (human === null) {
    const tag = (event as { readonly _tag?: string })._tag ?? "event";
    return `· ${tag} ${payload}`;
  }
  return `${human}\n  ⋯ ${payload}`;
};

export const isRenderableTaskTreeEvent = isTaskTreeEvent;
export const isRenderableMessageEvent = isMessageEvent;
export const isRenderablePaintBannerEvent = isPaintBannerEvent;
