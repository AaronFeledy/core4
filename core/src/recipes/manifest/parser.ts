/**
 * `recipe.yml` YAML parser — Alpha recipe.yml is a YAML subset covering
 * nested maps, lists, and lists-of-maps. The shape mirrors the Landofile
 * parser but does not reject `${...}` substrings, because recipe scalars
 * may carry `${VAR}` / `{{ expr }}` recipe expressions (§8.8.6) that
 * resolve at render time, not parse time.
 */
import { Effect } from "effect";

import { RecipeManifestParseError } from "@lando/sdk/errors";

export interface RecipeYamlParseOptions {
  readonly source: string;
  readonly content: string;
}

interface ParsedLine {
  readonly indent: number;
  readonly line: number;
  readonly text: string;
}

const parseError = (
  source: string,
  message: string,
  line?: number,
  column?: number,
): RecipeManifestParseError => new RecipeManifestParseError({ message, source, line, column });

const stripComment = (line: string): string => line.replace(/\s+#.*$/, "");

const guardKey = (source: string, key: string, line: number): void => {
  if (key === "__proto__") {
    throw parseError(source, `Reserved key \`__proto__\` is not allowed at line ${line}`, line);
  }
};

const parseInlineArray = (value: string, source: string, line: number): ReadonlyArray<unknown> => {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => parseScalar(part.trim(), source, line));
};

const parseScalar = (value: string, source: string, line: number): unknown => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseInlineArray(trimmed, source, line);
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    throw parseError(source, `Inline objects are not supported in recipe.yml at line ${line}`, line);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const toLines = (content: string, source: string): ReadonlyArray<ParsedLine> => {
  const lines: ParsedLine[] = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    if (rawLine.includes("\t")) {
      throw parseError(source, `Tabs are not supported in recipe.yml at line ${index + 1}`, index + 1);
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
  source: string,
  start: number,
  indent: number,
): readonly [Record<string, unknown>, number] => {
  const result: Record<string, unknown> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      throw parseError(source, `Malformed YAML indentation at line ${line.line}`, line.line, line.indent + 1);
    }
    if (line.text.startsWith("- ")) break;

    const match = line.text.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (match === null) {
      throw parseError(source, `Malformed YAML at line ${line.line}`, line.line, 1);
    }

    const [, key, rawValue] = match as [string, string, string];
    guardKey(source, key, line.line);

    if (rawValue.trim() === "") {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= line.indent) {
        result[key] = {};
        index += 1;
        continue;
      }
      if (next.text.startsWith("- ")) {
        const [items, nextIndex] = parseList(lines, source, index + 1, next.indent);
        result[key] = items;
        index = nextIndex;
        continue;
      }
      const [nested, nextIndex] = parseMap(lines, source, index + 1, next.indent);
      result[key] = nested;
      index = nextIndex;
      continue;
    }

    result[key] = parseScalar(rawValue, source, line.line);
    index += 1;
  }

  return [result, index];
};

const parseList = (
  lines: ReadonlyArray<ParsedLine>,
  source: string,
  start: number,
  indent: number,
): readonly [ReadonlyArray<unknown>, number] => {
  const result: unknown[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      throw parseError(source, `Malformed YAML indentation at line ${line.line}`, line.line, line.indent + 1);
    }
    if (!line.text.startsWith("- ")) break;

    const value = line.text.slice(2).trim();
    if (value === "") {
      throw parseError(
        source,
        `Only scalar arrays or maps are supported in recipe.yml at line ${line.line}`,
        line.line,
      );
    }

    const mapMatch = value.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (mapMatch !== null) {
      const [, firstKey, firstRawValueRaw] = mapMatch as [string, string, string?];
      const firstRawValue = firstRawValueRaw ?? "";
      guardKey(source, firstKey, line.line);
      const [item, nextIndex] = parseListItemMap(
        lines,
        source,
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

    result.push(parseScalar(value, source, line.line));
    index += 1;
  }

  return [result, index];
};

const parseListItemMap = (
  lines: ReadonlyArray<ParsedLine>,
  source: string,
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
        const [items, nextIndex] = parseList(lines, source, index, next.indent);
        item[key] = items;
        index = nextIndex;
        return;
      }
      const [nested, nextIndex] = parseMap(lines, source, index, next.indent);
      item[key] = nested;
      index = nextIndex;
      return;
    }
    item[key] = parseScalar(rawValue, source, keyLine);
  };

  consumeKey(firstKey, firstRawValue, startLine.line, childIndent);

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < childIndent) break;
    if (line.text.startsWith("- ")) break;
    if (line.indent > childIndent) {
      throw parseError(source, `Malformed YAML indentation at line ${line.line}`, line.line, line.indent + 1);
    }

    const match = line.text.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (match === null) {
      throw parseError(source, `Malformed YAML at line ${line.line}`, line.line, 1);
    }
    const [, key, rawValue] = match as [string, string, string];
    guardKey(source, key, line.line);
    index += 1;
    consumeKey(key, rawValue, line.line, childIndent);
  }

  return [item, index];
};

const parseYaml = ({ source, content }: RecipeYamlParseOptions): unknown => {
  const lines = toLines(content, source);
  const [parsed, index] = parseMap(lines, source, 0, 0);
  if (index < lines.length) {
    const line = lines[index];
    if (line !== undefined) {
      throw parseError(source, `Malformed YAML at line ${line.line}`, line.line, 1);
    }
  }
  return parsed;
};

export const parseRecipeYaml = (
  options: RecipeYamlParseOptions,
): Effect.Effect<unknown, RecipeManifestParseError> =>
  Effect.try({
    try: () => parseYaml(options),
    catch: (cause) =>
      cause instanceof RecipeManifestParseError
        ? cause
        : new RecipeManifestParseError({
            message: cause instanceof Error ? cause.message : "Failed to parse recipe.yml.",
            source: options.source,
            line: undefined,
            column: undefined,
            cause,
          }),
  });
