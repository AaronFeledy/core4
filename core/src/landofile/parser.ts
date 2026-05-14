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

import type { LandofileParseError } from "@lando/sdk/errors";
import { LandofileParseError as LandofileParseErrorClass } from "@lando/sdk/errors";

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

const stripComment = (line: string): string => line.replace(/\s+#.*$/, "");

const parseInlineArray = (value: string, filePath: string, line: number): ReadonlyArray<unknown> => {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => parseScalar(part.trim(), filePath, line));
};

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
    throw parseError(filePath, `Inline objects are not supported in Landofiles at line ${line}`, line);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
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

    const match = line.text.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (match === null) {
      throw parseError(filePath, `Malformed YAML at line ${line.line}`, line.line, 1);
    }

    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) {
      throw parseError(filePath, `Malformed YAML at line ${line.line}`, line.line, 1);
    }

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
    result.push(parseScalar(value, filePath, line.line));
    index += 1;
  }

  return [result, index];
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
