/**
 * Landofile YAML parser with `!load` and `!import` extensions.
 *
 * `!load` returns the parsed/raw value directly. `!import` returns an
 * `ImportRef` that preserves the original filename in metadata; consumers
 * like the CA installer use this to choose a sensible in-container filename.
 *
 * Hint suffixes:
 * - `@string` — read as UTF-8 string
 * - `@yaml` — parse as YAML
 * - `@json` — parse as JSON
 * - `@binary` — read as bytes; emit base64
 *
 * Default inference (when no hint):
 * - `.yml` / `.yaml` → `@yaml`
 * - `.json` → `@json`
 * - otherwise → `@string`
 *
 * The MVP parser supports the dependency-free Landofile subset used before a
 * full YAML parser dependency is introduced.
 */
import { Effect } from "effect";

import type { LandofileParseError } from "../errors/index.ts";
import { LandofileParseError as LandofileParseErrorClass } from "../errors/index.ts";

export type LoadHint = "string" | "yaml" | "json" | "binary";

export interface ImportRef {
  readonly _tag: "ImportRef";
  readonly path: string;
  readonly originalFilename: string;
  readonly content: string;
  readonly hint: LoadHint;
}

export interface ParseOptions {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}

interface ParsedLine {
  readonly indent: number;
  readonly line: number;
  readonly text: string;
}

const parseError = (filePath: string, message: string, line?: number, column?: number): LandofileParseError =>
  new LandofileParseErrorClass({ message, filePath, line, column });

const stripComment = (line: string): string => {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) {
    return line.replace(/\s+#.*$/, "");
  }

  const beforeColon = line.slice(0, colonIdx + 1);
  const afterColon = line.slice(colonIdx + 1);
  const valueIdx = afterColon.search(/\S/);
  if (valueIdx === -1) {
    return line;
  }

  const valuePrefix = afterColon.slice(0, valueIdx);
  const valuePart = afterColon.slice(valueIdx);

  // A comment can start immediately after the colon, e.g. `services: # services`.
  // Once `valuePrefix` is split off the leading whitespace is gone, so the
  // `/\s+#.*$/` fallback below cannot match. Detect this explicitly and drop the
  // comment so `parseMap` sees an empty value and can look for a nested block.
  if (valuePart.startsWith("#")) {
    return beforeColon;
  }

  if (valuePart.startsWith('"')) {
    let i = 1;
    while (i < valuePart.length) {
      if (valuePart[i] === "\\" && i + 1 < valuePart.length) {
        i += 2;
      } else if (valuePart[i] === '"') {
        i += 1;
        break;
      } else {
        i += 1;
      }
    }
    const tail = valuePart.slice(i).replace(/\s+#.*$/, "");
    return beforeColon + valuePrefix + valuePart.slice(0, i) + tail;
  }

  if (valuePart.startsWith("'")) {
    let i = 1;
    while (i < valuePart.length) {
      if (valuePart[i] === "'" && valuePart[i + 1] === "'") {
        i += 2;
      } else if (valuePart[i] === "'") {
        i += 1;
        break;
      } else {
        i += 1;
      }
    }
    const tail = valuePart.slice(i).replace(/\s+#.*$/, "");
    return beforeColon + valuePrefix + valuePart.slice(0, i) + tail;
  }

  return beforeColon + valuePrefix + valuePart.replace(/\s+#.*$/, "");
};

const splitInlineArray = (value: string): ReadonlyArray<string> => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
};

const parseInlineArray = (value: string, filePath: string, line: number): ReadonlyArray<unknown> => {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return splitInlineArray(inner).map((part) => parseScalar(part.trim(), filePath, line));
};

const unescapeDoubleQuotedScalar = (value: string): string =>
  value.replace(/\\([\\"nrt])/g, (_, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });

const parseScalar = (value: string, filePath: string, line: number): unknown => {
  if (value.includes("${")) {
    throw parseError(filePath, `Expressions are not supported in Landofiles at line ${line}`, line);
  }

  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseInlineArray(trimmed, filePath, line);
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    // The flow-empty map `{}` is the only inline object the Landofile emitter
    // produces (for empty records, which have no block sequence-item form).
    // Round-trip it while populated inline objects stay rejected.
    if (trimmed.slice(1, -1).trim() === "") return {};
    throw parseError(filePath, `Inline objects are not supported in Landofiles at line ${line}`, line);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeDoubleQuotedScalar(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const toLines = (content: string, filePath: string): ReadonlyArray<ParsedLine> => {
  const lines: ParsedLine[] = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    if (rawLine.includes("\t")) {
      throw parseError(filePath, `Tabs are not supported in Landofiles at line ${index + 1}`, index + 1);
    }

    const withoutComment = stripComment(rawLine);
    const text = withoutComment.trim();
    if (text === "" || text.startsWith("#")) continue;

    lines.push({ indent: withoutComment.match(/^ */)?.[0].length ?? 0, line: index + 1, text });
  }
  return lines;
};

const parseMap = (
  lines: ReadonlyArray<ParsedLine>,
  filePath: string,
  start: number,
  indent: number,
): readonly [Record<string, unknown>, number] => {
  const result: Record<string, unknown> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      throw parseError(
        filePath,
        `Malformed YAML indentation at line ${line.line}`,
        line.line,
        line.indent + 1,
      );
    }
    if (line.text.startsWith("- ")) break;

    const match = line.text.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (match === null) {
      throw parseError(filePath, `Malformed YAML at line ${line.line}`, line.line, 1);
    }

    const [, key, rawValue] = match as [string, string, string];

    if (rawValue.trim() === "") {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= line.indent) {
        result[key] = {};
        index += 1;
        continue;
      }
      if (next.text.startsWith("- ")) {
        const [items, nextIndex] = parseList(lines, filePath, index + 1, next.indent);
        result[key] = items;
        index = nextIndex;
        continue;
      }
      const [nested, nextIndex] = parseMap(lines, filePath, index + 1, next.indent);
      result[key] = nested;
      index = nextIndex;
      continue;
    }

    result[key] = parseScalar(rawValue, filePath, line.line);
    index += 1;
  }

  return [result, index];
};

const parseList = (
  lines: ReadonlyArray<ParsedLine>,
  filePath: string,
  start: number,
  indent: number,
): readonly [ReadonlyArray<unknown>, number] => {
  const result: unknown[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      throw parseError(
        filePath,
        `Malformed YAML indentation at line ${line.line}`,
        line.line,
        line.indent + 1,
      );
    }
    if (!line.text.startsWith("- ")) break;

    const value = line.text.slice(2).trim();
    if (value === "") {
      throw parseError(
        filePath,
        `Only scalar arrays are supported in Landofiles at line ${line.line}`,
        line.line,
      );
    }

    const mapMatch = value.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (mapMatch !== null) {
      const [, firstKey, firstRawValueRaw] = mapMatch as [string, string, string?];
      const firstRawValue = firstRawValueRaw ?? "";
      const [item, nextIndex] = parseListItemMap(
        lines,
        filePath,
        index,
        line,
        indent + 2,
        firstKey,
        firstRawValue,
      );
      result.push(item);
      index = nextIndex;
      continue;
    }

    result.push(parseScalar(value, filePath, line.line));
    index += 1;
  }

  return [result, index];
};

const parseListItemMap = (
  lines: ReadonlyArray<ParsedLine>,
  filePath: string,
  startIndex: number,
  startLine: ParsedLine,
  childIndent: number,
  firstKey: string,
  firstRawValue: string,
): readonly [Record<string, unknown>, number] => {
  const item: Record<string, unknown> = {};
  let index = startIndex + 1;

  const consumeKey = (key: string, rawValue: string, keyLine: number, keyIndent: number): void => {
    if (rawValue.trim() === "") {
      const next = lines[index];
      if (next === undefined || next.indent <= keyIndent) {
        item[key] = {};
        return;
      }
      if (next.text.startsWith("- ")) {
        const [items, nextIndex] = parseList(lines, filePath, index, next.indent);
        item[key] = items;
        index = nextIndex;
        return;
      }
      const [nested, nextIndex] = parseMap(lines, filePath, index, next.indent);
      item[key] = nested;
      index = nextIndex;
      return;
    }
    item[key] = parseScalar(rawValue, filePath, keyLine);
  };

  consumeKey(firstKey, firstRawValue, startLine.line, childIndent);

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < childIndent) break;
    if (line.text.startsWith("- ")) break;
    if (line.indent > childIndent) {
      throw parseError(
        filePath,
        `Malformed YAML indentation at line ${line.line}`,
        line.line,
        line.indent + 1,
      );
    }

    const match = line.text.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (match === null) {
      throw parseError(filePath, `Malformed YAML at line ${line.line}`, line.line, 1);
    }
    const [, key, rawValue] = match as [string, string, string];
    index += 1;
    consumeKey(key, rawValue, line.line, childIndent);
  }

  return [item, index];
};

const parseYaml = ({ content, file }: ParseOptions): unknown => {
  const lines = toLines(content, file);
  const [parsed, index] = parseMap(lines, file, 0, 0);
  if (index < lines.length) {
    const line = lines[index];
    if (line !== undefined) {
      throw parseError(file, `Malformed YAML at line ${line.line}`, line.line, 1);
    }
  }
  return parsed;
};

export const parseLandofile = (options: ParseOptions): Effect.Effect<unknown, LandofileParseError> =>
  Effect.try({
    try: () => parseYaml(options),
    catch: (cause) =>
      cause instanceof LandofileParseErrorClass
        ? cause
        : new LandofileParseErrorClass({
            message: cause instanceof Error ? cause.message : "Failed to parse Landofile.",
            filePath: options.file,
            line: undefined,
            column: undefined,
            cause,
          }),
  });
