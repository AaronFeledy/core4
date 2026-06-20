// Pure ownership-marker and block-fence helpers for `ManagedFileService`. The
// inline marker is the user-facing adoption affordance: deleting it tells Lando
// to stop touching the file. `file` mode writes a first-line marker (per-format
// comment syntax; JSON falls back to an `x-lando-generated` key plus the
// ledger). `block` mode owns only the region between `>>> lando:<id> >>>` and
// `<<< lando:<id> <<<` fences inside a user-owned file.
//
// This module is pure: no Effect runtime, no filesystem. Callers handle IO and
// map any structural failure into `ManagedFileError`.

import type { FileFormat } from "@lando/sdk/schema";

const MARKER_TAG = "lando-generated";
const JSON_MARKER_KEY = "x-lando-generated";

/**
 * The line-comment prefix for a format, or `null` for formats without line
 * comments (JSON). `text`/`env`/`yaml`/`landofile` use `#`.
 */
export const commentPrefix = (format: FileFormat): string | null => {
  switch (format) {
    case "json":
      return null;
    case "ini":
      return ";";
    default:
      return "#";
  }
};

const markerLine = (prefix: string, marker: string): string =>
  `${prefix} ${MARKER_TAG}:${marker} — managed by Lando; delete this line to adopt this file.`;

const isMarkerLine = (line: string, marker: string): boolean =>
  new RegExp(`${MARKER_TAG}:${escapeRegExp(marker)}(?:\\b|$)`, "u").test(line);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const ensureTrailingNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Compose the full on-disk content for `file` mode: a first-line ownership
 * marker plus the rendered body. JSON injects an `x-lando-generated` key when
 * the body is a JSON object; otherwise ownership rests on the ledger.
 */
export const composeFileContent = (format: FileFormat, marker: string, body: string): string => {
  const prefix = commentPrefix(format);
  if (prefix === null) {
    // JSON: inject the marker key when possible, else write the body verbatim.
    try {
      const parsed = JSON.parse(body) as unknown;
      if (isPlainObject(parsed)) {
        return `${JSON.stringify({ ...parsed, [JSON_MARKER_KEY]: marker }, null, 2)}\n`;
      }
    } catch {
      // Not a JSON object — fall through to verbatim.
    }
    return ensureTrailingNewline(body);
  }
  return `${markerLine(prefix, marker)}\n${ensureTrailingNewline(body)}`;
};

/** Whether this full-file content shape has a user-removable marker slot. */
export const canCarryFileMarker = (format: FileFormat, content: string): boolean => {
  const prefix = commentPrefix(format);
  if (prefix !== null) return true;
  try {
    return isPlainObject(JSON.parse(content) as unknown);
  } catch {
    return false;
  }
};

/** Whether `content` already carries `file`-mode ownership for `marker`. */
export const hasFileMarker = (format: FileFormat, content: string, marker: string): boolean => {
  const prefix = commentPrefix(format);
  if (prefix === null) {
    try {
      const parsed = JSON.parse(content) as unknown;
      return isPlainObject(parsed) && parsed[JSON_MARKER_KEY] === marker;
    } catch {
      return false;
    }
  }
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    return isMarkerLine(line, marker);
  }
  return false;
};

/** Remove the ownership marker so future applies treat the file as adopted. */
export const stripFileMarker = (format: FileFormat, content: string, marker: string): string => {
  const prefix = commentPrefix(format);
  if (prefix === null) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (isPlainObject(parsed) && JSON_MARKER_KEY in parsed) {
        const { [JSON_MARKER_KEY]: _removed, ...rest } = parsed;
        return `${JSON.stringify(rest, null, 2)}\n`;
      }
    } catch {
      // Not JSON — return unchanged.
    }
    return content;
  }
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index >= 0 && isMarkerLine(lines[index] ?? "", marker)) {
    lines.splice(index, 1);
  }
  return lines.join("\n");
};

export interface BlockLocation {
  readonly found: boolean;
  /** The managed slice including both fences, when found. */
  readonly slice: string;
  /** Content before the opening fence (no trailing newline collapsing). */
  readonly before: string;
  /** Content after the closing fence. */
  readonly after: string;
}

const fenceOpen = (prefix: string, marker: string): string => `${prefix} >>> lando:${marker} >>>`;
const fenceClose = (prefix: string, marker: string): string => `${prefix} <<< lando:${marker} <<<`;

/** Build the fenced managed region for `block` mode. */
export const composeBlock = (prefix: string, marker: string, body: string): string => {
  const trimmed = body.replace(/\n+$/u, "");
  return `${fenceOpen(prefix, marker)}\n${trimmed}\n${fenceClose(prefix, marker)}`;
};

/** Locate the fenced managed region for `marker` inside `content`. */
export const findBlock = (prefix: string, marker: string, content: string): BlockLocation => {
  const lines = content.split(/\r?\n/u);
  const openLine = fenceOpen(prefix, marker);
  const closeLine = fenceClose(prefix, marker);
  const start = lines.findIndex((line) => line.trim() === openLine);
  if (start === -1) return { found: false, slice: "", before: content, after: "" };
  const end = lines.findIndex((line, idx) => idx > start && line.trim() === closeLine);
  if (end === -1) return { found: false, slice: "", before: content, after: "" };
  return {
    found: true,
    slice: lines.slice(start, end + 1).join("\n"),
    before: lines.slice(0, start).join("\n"),
    after: lines.slice(end + 1).join("\n"),
  };
};

/** Insert a managed block into a (possibly empty/new) user file. */
export const insertBlock = (existing: string | null, block: string): string => {
  if (existing === null || existing === "") return `${block}\n`;
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}${block}\n`;
};

/** Replace the located managed region with a new block, preserving surrounding content. */
export const replaceBlock = (location: BlockLocation, block: string): string => {
  const before = location.before === "" ? "" : `${location.before}\n`;
  const after = location.after === "" ? "" : `\n${location.after.replace(/^\n+/u, "")}`;
  return `${before}${block}${after === "" ? "\n" : `${after}\n`}`;
};

/** Remove a managed block (adoption / removal) leaving the surrounding file intact. */
export const removeBlock = (location: BlockLocation): string => {
  const before = location.before.replace(/\n+$/u, "");
  const after = location.after.replace(/^\n+/u, "");
  if (before === "") return after === "" ? "" : `${after}\n`;
  if (after === "") return `${before}\n`;
  return `${before}\n${after}\n`;
};
