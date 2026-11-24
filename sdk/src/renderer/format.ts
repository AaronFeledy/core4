import { Schema } from "effect";

import { LockWaitEvent, type LockWaitHolder } from "../events/lock.ts";
import type { LandoEvent as KnownLandoEvent } from "../events/union.ts";
import type { LandoEvent } from "../services/index.ts";

const TASK_TREE_TAGS = [
  "task.tree.start",
  "task.tree.complete",
  "task.start",
  "task.complete",
  "task.fail",
  "task.detail",
] as const;
const MESSAGE_TAGS = ["message.info", "message.warn", "message.error"] as const;
const OTHER_RENDERABLE_TAGS = [
  "paint.banner",
  "image-pull-progress",
  "notify.desktop",
  "code.snippet",
  "diff.render",
  "markdown.block",
] as const;
const RENDERABLE_TAGS: ReadonlySet<string> = new Set([
  ...TASK_TREE_TAGS,
  ...MESSAGE_TAGS,
  ...OTHER_RENDERABLE_TAGS,
]);

type RenderableEvent =
  | Extract<
      KnownLandoEvent,
      {
        readonly _tag:
          | (typeof TASK_TREE_TAGS)[number]
          | (typeof MESSAGE_TAGS)[number]
          | (typeof OTHER_RENDERABLE_TAGS)[number];
      }
    >
  | LockWaitEvent;

const hasTag =
  (tags: ReadonlyArray<string>) =>
  (event: LandoEvent): boolean =>
    tags.includes(event._tag);

const isTaskTreeEvent = hasTag(TASK_TREE_TAGS);
const isMessageEvent = hasTag(MESSAGE_TAGS);
const isPaintBannerEvent = (event: LandoEvent): boolean => event._tag === "paint.banner";
export const isLockWaitEvent = Schema.is(LockWaitEvent);

// EventService delivery validates every known tag against its schema, so the tag identifies the shape.
const isRenderableEvent = (event: LandoEvent): event is RenderableEvent =>
  RENDERABLE_TAGS.has(event._tag) || isLockWaitEvent(event);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export const formatDurationSuffix = (durationMs: number | undefined): string => {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return ` (${Math.round(durationMs)}ms)`;
  return ` (${(durationMs / 1000).toFixed(1)}s)`;
};

/** Human duration for waits: 0.4s, 9.5s, 16s, 2m, 2m 5s. */
export const formatWaitDuration = (ms: number): string => {
  const seconds = Math.max(0, ms) / 1_000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const rest = whole % 60;
  return rest === 0 ? `${Math.floor(whole / 60)}m` : `${Math.floor(whole / 60)}m ${rest}s`;
};

const lockHolderName = (holder: LockWaitHolder): string => {
  const command = holder.command ?? "another Lando command";
  return holder.app === undefined ? command : `${command} in ${holder.app}`;
};

const lockHolderAge = (holder: LockWaitHolder): string =>
  `(pid ${holder.pid}, running ${formatWaitDuration(holder.heldMs)})`;

/** `lando start in alpha (pid 691865, running 16s)`. */
export const formatLockHolder = (holder: LockWaitHolder): string =>
  `${lockHolderName(holder)} ${lockHolderAge(holder)}`;

/** The phrase after "Waiting for": `lando start in alpha to finish (pid 691865, running 16s)`. */
export const formatLockWaitPhrase = (
  wait: Pick<LockWaitEvent, "resource" | "subject" | "holder">,
): string => {
  const holder = wait.holder;
  // Shared holders write no record, and neither does an exclusive holder in its first instant.
  if (holder === undefined) return `${wait.resource}, which other Lando commands are using`;
  const action = wait.subject === "app" ? "to finish" : `to release ${wait.resource}`;
  return `${lockHolderName(holder)} ${action} ${lockHolderAge(holder)}`;
};

export const formatLockWaitNotice = (event: LockWaitEvent): string =>
  event.reminder
    ? `Still waiting for ${formatLockWaitPhrase(event)}; giving up in ${formatWaitDuration(event.remainingMs)}.`
    : `Waiting for ${formatLockWaitPhrase(event)}.`;

export const formatPlainEvent = (event: RenderableEvent): string | null => {
  switch (event._tag) {
    case "message.info":
      return `ℹ ${event.body}`;
    case "message.warn":
      return `⚠ ${event.body}`;
    case "message.error": {
      const main = `✗ ${event.body}`;
      return event.remediation === undefined ? main : `${main}\n  ↳ ${event.remediation}`;
    }
    case "task.tree.start": {
      const count = event.children.length;
      return `▼ ${event.label} (${count} ${count === 1 ? "step" : "steps"})`;
    }
    case "task.start":
      return `[${event.taskId}] start: ${event.label}`;
    case "task.detail": {
      const prefix = event.stream === "stderr" ? `[${event.taskId}] !` : `[${event.taskId}]`;
      return `${prefix} ${event.line}`;
    }
    case "task.complete": {
      const tail = event.summary === undefined ? "" : `: ${event.summary}`;
      const glyph = event.outcome === "info" ? "•" : event.outcome === "warn" ? "⚠" : "✓";
      return `[${event.taskId}] ${glyph} complete${tail}${formatDurationSuffix(event.durationMs)}`;
    }
    case "task.fail": {
      const tail = event.summary === undefined ? "" : `: ${event.summary}`;
      const exitSuffix = event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`;
      const main = `[${event.taskId}] ✗ fail${tail}${exitSuffix}${formatDurationSuffix(event.durationMs)}`;
      return event.remediation === undefined ? main : `${main}\n[${event.taskId}]   ↳ ${event.remediation}`;
    }
    case "task.tree.complete": {
      // An unsummarized failed tree must not read as complete.
      const label = event.summary ?? (event.outcome === "failure" ? "failed" : (event.outcome ?? "complete"));
      return `▶ ${label} (${event.succeeded} ✓ · ${event.failed} ✗)${formatDurationSuffix(event.durationMs)}`;
    }
    case "paint.banner": {
      return null;
    }
    case "lock.wait":
      return `${event.reminder ? "ℹ" : "⚠"} ${formatLockWaitNotice(event)}`;
    case "image-pull-progress": {
      const { reference, current, total } = event;
      const stream = event.stream?.trim();
      if (
        stream === "Starting to pull artifact" ||
        stream === "Pulling artifact" ||
        stream === "Artifact pulled successfully" ||
        stream === "Artifact already exists" ||
        /^Copying (?:blob|config) sha256:[0-9a-f]+$/iu.test(stream ?? "")
      )
        return null;
      const message = stream === undefined || stream.length === 0 ? "" : `: ${stream}`;
      const progress = current === undefined ? "" : ` (${current}${total === undefined ? "" : `/${total}`})`;
      return `↓ Pulling ${reference}${message}${progress}`;
    }
    case "code.snippet": {
      const { code, language } = event;
      if (language === undefined || language.length === 0) return code;
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case "diff.render":
      return event.unified;
    case "markdown.block":
      return event.markdown;
    default:
      return null;
  }
};

export const renderPlainLine = (event: LandoEvent): string | null => {
  if (event._tag === "log.line") {
    return asString(event.line) ?? asString(event.message) ?? "";
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
  const result: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    if (Object.hasOwn(event, key)) result[key] = event[key];
  }
  for (const key of Object.keys(event)) {
    if (!Object.hasOwn(result, key)) result[key] = event[key];
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
  const human = isRenderableEvent(event) ? formatPlainEvent(event) : null;
  if (human === null) return `· ${event._tag} ${payload}`;
  return `${human}\n  ⋯ ${payload}`;
};

export const isRenderableTaskTreeEvent = isTaskTreeEvent;
export const isRenderableMessageEvent = isMessageEvent;
export const isRenderablePaintBannerEvent = isPaintBannerEvent;
