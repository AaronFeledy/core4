import { splitMappingEntry } from "@lando/sdk/landofile";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { Result } from "effect";

export interface UnsupportedEdit {
  readonly reason: string;
}

export const unsupported = (reason: string): Result.Result<never, UnsupportedEdit> => Result.fail({ reason });

export interface YamlLine {
  readonly start: number;
  readonly end: number;
  readonly contentEnd: number;
  readonly indent: number;
  readonly body: string;
  readonly code: string;
}

// Only a value's opening quote starts quoted mode. Apostrophes in plain text are literal.
export const commentOffset = (text: string): number => {
  let quote = /^["']/.test(text.trimStart()) ? text.trimStart()[0] : undefined;
  let opened = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== undefined) {
      if (!opened) {
        if (char === quote) opened = true;
        continue;
      }
      if (quote === '"' && char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = undefined;
      }
    } else if (char === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) return i;
  }
  return text.length;
};

export const scanYamlLines = (source: string): Result.Result<readonly YamlLine[], UnsupportedEdit> => {
  const lines: YamlLine[] = [];
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (match[0] === "") continue;
    const start = match.index;
    const text = match[0].replace(/[\r\n]+$/, "");
    if (text.includes("\t") || /^(?:---|\.\.\.)(?:\s|$)/.test(text)) {
      return unsupported("Tabs or document separators cannot be edited safely.");
    }
    const body = text.trimStart();
    const indent = text.length - body.length;
    lines.push({
      start,
      end: start + match[0].length,
      contentEnd: start + text.length,
      indent,
      body,
      code: body.startsWith("#") ? "" : body,
    });
  }
  return Result.succeed(lines);
};

export interface LocatedEntry {
  readonly line: YamlLine;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: string;
  readonly regionEnd: number;
  readonly children: readonly YamlLine[];
}

export interface LocatedEdit {
  readonly entry?: LocatedEntry | undefined;
  readonly parent?: LocatedEntry | undefined;
  readonly remaining: ValidationIssuePath;
  readonly entries: readonly LocatedEntry[];
  readonly indent: number;
  /** The parent is an empty `{}` mapping (e.g. left by an unset); a set must rewrite it as a block mapping. */
  readonly emptyFlowParent?: boolean;
}

const entriesIn = (lines: readonly YamlLine[], segment: string | number) => {
  const indent = lines.find((line) => line.code.trim() !== "")?.indent ?? 0;
  const entries: LocatedEntry[] = [];
  const keys = new Set<string>();
  for (const [lineIndex, line] of lines.entries()) {
    if (line.code.trim() === "" || line.indent !== indent) continue;
    const mapping = typeof segment === "string" ? splitMappingEntry(line.body) : undefined;
    const listItem = typeof segment === "number" && /^-\s+/.test(line.body);
    if (mapping === undefined && !listItem) return unsupported("Uncertain block syntax on the edited path.");
    const key = mapping?.key ?? String(entries.length);
    if (keys.has(key) || mapping?.isMergeKey)
      return unsupported("Duplicate or merge keys in an affected mapping.");
    keys.add(key);
    const prefixLength = mapping === undefined ? 1 : mapping.rawKey.length + 1;
    const keyEnd = line.start + line.indent + prefixLength;
    const afterKey = line.body.slice(prefixLength);
    const raw = afterKey.trimStart();
    const value = raw.slice(0, commentOffset(raw)).trimEnd();
    const valueStart = keyEnd + afterKey.length - raw.length;
    let boundary = lineIndex + 1;
    while (boundary < lines.length) {
      const child = lines[boundary];
      if (child !== undefined && child.code.trim() !== "" && child.indent <= indent) break;
      boundary += 1;
    }
    const children = lines.slice(lineIndex + 1, boundary);
    const last = children.filter((child) => child.code.trim() !== "").at(-1);
    entries.push({
      line,
      keyEnd,
      valueStart,
      valueEnd: valueStart + value.length,
      value,
      regionEnd: last?.end ?? line.end,
      children,
    });
  }
  return Result.succeed({ entries, keys: [...keys], indent });
};

export const locateYamlEdit = (
  lines: readonly YamlLine[],
  segments: ValidationIssuePath,
): Result.Result<LocatedEdit, UnsupportedEdit> => {
  let scope = lines;
  let parent: LocatedEntry | undefined;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return unsupported("Missing path segment.");
    const found = entriesIn(scope, segment);
    if (Result.isFailure(found)) return Result.fail(found.failure);
    const { entries, keys, indent } = found.success;
    const entry = typeof segment === "string" ? entries[keys.indexOf(segment)] : entries[segment];
    if (entry === undefined) {
      if (typeof segment === "number")
        return unsupported("Sparse or missing list indices cannot be edited safely.");
      return Result.succeed({
        parent,
        remaining: segments.slice(i),
        entries,
        indent: entries.length > 0 ? indent : (parent?.line.indent ?? -2) + 2,
      });
    }
    if (/^[!&*]|^<<:/.test(entry.value))
      return unsupported("Tags, anchors, aliases or merge keys on the edited path.");
    const final = i === segments.length - 1;
    if (!final && entry.value === "{}" && typeof segments[i + 1] === "string" && entry.children.length === 0)
      return Result.succeed({
        parent: entry,
        remaining: segments.slice(i + 1),
        entries: [],
        indent: entry.line.indent + 2,
        emptyFlowParent: true,
      });
    const wholeFlowValue = /^\[.*\]$|^\{.*\}$/.test(entry.value);
    if (/^[[{]/.test(entry.value) && !(final && wholeFlowValue))
      return unsupported("Flow collections on the edited path.");
    if (typeof segment === "number" && splitMappingEntry(entry.value) !== undefined)
      return unsupported("List-item mappings cannot be edited safely.");
    if (final) return Result.succeed({ entry, parent, remaining: [], entries, indent });
    if (entry.value !== "")
      return unsupported(
        "Flow collections, scalar parents, list-item maps or block-scalar parents on the edited path.",
      );
    parent = entry;
    scope = entry.children;
  }
  return unsupported("Empty edit path.");
};

export const subtreeHasAnchor = (entry: LocatedEntry): boolean =>
  [entry.line, ...entry.children].some((line) =>
    /(?:^|:\s+|-\s+)&[\w-]+/.test(line.code.slice(0, commentOffset(line.code))),
  );
