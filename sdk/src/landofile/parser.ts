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
 * Dependency-free Landofile YAML subset (no external YAML parser).
 */
import { Effect } from "effect";

import type { LandofileParseError } from "../errors/index.ts";
import { LandofileParseError as LandofileParseErrorClass } from "../errors/index.ts";
import {
  YAML_REFERENCE_NAME_PATTERN,
  type YamlReferenceState,
  bindYamlAnchor,
  makeYamlAlias,
  makeYamlReferenceState,
  parseYamlReferenceSyntax,
  registerYamlMerge,
  reserveYamlAnchor,
  resolveYamlReferences,
} from "./yaml-references.ts";

export type LoadHint = "string" | "yaml" | "json" | "binary";

export interface ParseOptions {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
  readonly limits?: {
    readonly maxContentBytes?: number;
    readonly maxDepth?: number;
  };
}

export type LandofileTag = "!reset" | "!override";

export interface LandofileTagOccurrence {
  readonly tag: LandofileTag;
  readonly line: number; // 1-based
  readonly column: number; // 1-based, column of the leading "!"
}

interface ParsedLine {
  readonly indent: number;
  readonly line: number;
  readonly text: string;
  readonly sourceLines: ReadonlyArray<string>;
}

const parseError = (filePath: string, message: string, line?: number, column?: number): LandofileParseError =>
  new LandofileParseErrorClass({ message, filePath, line, column });

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;

const ANCHOR_PREFIX_PATTERN = new RegExp(`^&${YAML_REFERENCE_NAME_PATTERN.source}\\s+`);

// A double-quoted key carries the JSON escape subset the emitter writes, so any
// string key round-trips even when YAML cannot hold it plain.
const QUOTED_KEY = String.raw`"(?:[^"\\\u0000-\u001F]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"`;
const MAPPING_ENTRY_PATTERN = new RegExp(
  `^(${QUOTED_KEY}|<<|[A-Za-z0-9_.@/-]+(?::[A-Za-z0-9_.@/-]+)*):((?:\\s+.*)?)$`,
);
const MAPPING_ENTRY_FALLBACK_PATTERN = new RegExp(`^(${QUOTED_KEY}|<<|[A-Za-z0-9_.@/-]+):(.*)$`);

/**
 * A mapping entry keeps its raw source token beside the decoded key. Source
 * columns, comment reconstruction, and merge-key detection are lexical
 * questions a decoded key can no longer answer once quotes and escapes are gone.
 */
interface MappingEntry {
  readonly key: string;
  readonly rawKey: string;
  readonly rawValue: string;
  readonly isMergeKey: boolean;
}

const splitMappingEntry = (
  text: string,
  options: { readonly compactValue?: boolean } = {},
): MappingEntry | undefined => {
  const match =
    text.match(MAPPING_ENTRY_PATTERN) ??
    (options.compactValue === true ? text.match(MAPPING_ENTRY_FALLBACK_PATTERN) : null);
  if (match === null) return undefined;
  const rawKey = match[1];
  const rawValue = match[2];
  if (rawKey === undefined || rawValue === undefined) return undefined;
  const quoted = rawKey.startsWith('"');
  return {
    key: quoted ? unescapeDoubleQuotedScalar(rawKey.slice(1, -1)) : rawKey,
    rawKey,
    rawValue,
    isMergeKey: !quoted && rawKey === "<<",
  };
};

const assignKeyedValue = (
  references: YamlReferenceState,
  target: Record<string, unknown>,
  entry: { readonly key: string; readonly isMergeKey: boolean },
  value: unknown,
  location: { readonly line: number; readonly column: number },
  blockAnchorName: string | undefined,
): void => {
  if (blockAnchorName !== undefined) bindYamlAnchor(references, blockAnchorName, value);
  if (entry.isMergeKey) registerYamlMerge(references, target, value, location);
  // `__proto__` is an ordinary document key, so define the property instead of
  // assigning through a setter that would mutate the prototype.
  else {
    Object.defineProperty(target, entry.key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
};

const assertContentSize = (content: string, filePath: string, maxContentBytes: number): void => {
  const actualContentBytes = Buffer.byteLength(content, "utf8");
  if (actualContentBytes > maxContentBytes) {
    throw parseError(
      filePath,
      `Landofile exceeds the maximum input size: ${actualContentBytes} bytes > ${maxContentBytes} bytes`,
    );
  }
};

const assertDepth = (filePath: string, line: number, depth: number, maxDepth: number): void => {
  if (depth > maxDepth) {
    throw parseError(
      filePath,
      `Landofile nesting depth exceeds the maximum depth of ${maxDepth} at line ${line}`,
      line,
    );
  }
};

const stripComment = (line: string): string => {
  const indent = line.match(/^ */)?.[0] ?? "";
  const entry = splitMappingEntry(line.slice(indent.length), { compactValue: true });
  if (entry === undefined) {
    return line.replace(/\s+#.*$/, "");
  }

  const { rawKey, rawValue: afterColon } = entry;
  const beforeColon = `${indent}${rawKey}:`;
  const valueIdx = afterColon.search(/\S/);
  if (valueIdx === -1) {
    return line;
  }

  const rawValue = afterColon.slice(valueIdx);
  const anchorPrefix = rawValue.match(ANCHOR_PREFIX_PATTERN)?.[0] ?? "";
  const valuePrefix = afterColon.slice(0, valueIdx) + anchorPrefix;
  const valuePart = rawValue.slice(anchorPrefix.length);

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

const parseInlineArray = (
  value: string,
  filePath: string,
  line: number,
  column: number,
  depth: number,
  maxDepth: number,
  references: YamlReferenceState,
): ReadonlyArray<unknown> => {
  assertDepth(filePath, line, depth, maxDepth);
  const inner = value.slice(1, -1);
  if (inner.trim() === "") return [];
  let cursor = 0;
  return splitInlineArray(inner).map((part) => {
    const offset = inner.indexOf(part, cursor);
    cursor = offset + part.length + 1;
    return parseScalar(part, filePath, line, column + 1 + offset, depth, maxDepth, references);
  });
};

const unescapeDoubleQuotedScalar = (value: string): string =>
  value.replace(/\\(u[0-9a-fA-F]{4}|[\\"/nrtbf])/g, (_, escaped: string) => {
    if (escaped.startsWith("u") && escaped.length === 5) {
      return String.fromCharCode(Number.parseInt(escaped.slice(1), 16));
    }
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === "b") return "\b";
    if (escaped === "f") return "\f";
    return escaped;
  });

const parseScalar = (
  value: string,
  filePath: string,
  line: number,
  column: number,
  depth: number,
  maxDepth: number,
  references: YamlReferenceState,
): unknown => {
  const trimmed = value.trim();

  // A quoted scalar is a literal: its content is never re-interpreted as an
  // expression, so a translator fragment carrying `${secret:…}` round-trips
  // unchanged. The `${…}` expression rejection below applies only to UNQUOTED
  // scalars.
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeDoubleQuotedScalar(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  const reference = parseYamlReferenceSyntax(value, { line, column });
  if (reference.kind === "alias") return makeYamlAlias(reference);
  if (reference.kind === "anchor") {
    reserveYamlAnchor(references, reference);
    const anchored = parseScalar(
      reference.value,
      filePath,
      line,
      reference.valueColumn,
      depth,
      maxDepth,
      references,
    );
    bindYamlAnchor(references, reference.name, anchored);
    return anchored;
  }

  if (trimmed.includes("${")) {
    throw parseError(filePath, `Expressions are not supported in Landofiles at line ${line}`, line);
  }

  if (trimmed === "") return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const leadingWhitespace = value.search(/\S/);
    return parseInlineArray(
      trimmed,
      filePath,
      line,
      column + Math.max(leadingWhitespace, 0),
      depth + 1,
      maxDepth,
      references,
    );
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    // The flow-empty map `{}` is the only inline object the Landofile emitter
    // produces (for empty records, which have no block sequence-item form).
    // Round-trip it while populated inline objects stay rejected.
    if (trimmed.slice(1, -1).trim() === "") return {};
    throw parseError(filePath, `Inline objects are not supported in Landofiles at line ${line}`, line);
  }
  return trimmed;
};

const toLines = (content: string, filePath: string): ReadonlyArray<ParsedLine> => {
  const lines: ParsedLine[] = [];
  const sourceLines = content.split(/\r?\n/);
  for (const [index, rawLine] of sourceLines.entries()) {
    if (rawLine.includes("\t")) {
      throw parseError(filePath, `Tabs are not supported in Landofiles at line ${index + 1}`, index + 1);
    }

    const withoutComment = stripComment(rawLine);
    const text = withoutComment.trim();
    if (text === "" || text.startsWith("#")) continue;

    lines.push({ indent: withoutComment.match(/^ */)?.[0].length ?? 0, line: index + 1, text, sourceLines });
  }
  return lines;
};

interface ValuePosition {
  readonly line: number;
  readonly column: number;
}

// Skip indentation and an optional `&name` prefix so Compose tags after anchors
// are still matched at the tag token.
const skipValuePrefix = (value: string): { readonly text: string; readonly offset: number } => {
  const leadingWhitespace = value.search(/\S/);
  if (leadingWhitespace < 0) return { text: "", offset: 0 };
  const withoutIndent = value.slice(leadingWhitespace);
  const anchorLength = withoutIndent.match(ANCHOR_PREFIX_PATTERN)?.[0].length ?? 0;
  return { text: withoutIndent.slice(anchorLength), offset: leadingWhitespace + anchorLength };
};

const detectLeadingTag = (value: string, position: ValuePosition): LandofileTagOccurrence | undefined => {
  const { text: trimmed, offset } = skipValuePrefix(value);
  if (trimmed === "") return undefined;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return undefined;
  if (!/^!(?:reset|override)(?=$|\s)/.test(trimmed)) return undefined;

  return {
    tag: trimmed.startsWith("!reset") ? "!reset" : "!override",
    line: position.line,
    column: position.column + offset,
  };
};

const detectTagsInValue = (value: string, position: ValuePosition): ReadonlyArray<LandofileTagOccurrence> => {
  const leading = detectLeadingTag(value, position);
  if (leading !== undefined) return [leading];

  const { text: trimmed, offset } = skipValuePrefix(value);
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];

  const inner = trimmed.slice(1, -1);
  const occurrences: LandofileTagOccurrence[] = [];
  let cursor = 0;
  for (const item of splitInlineArray(inner)) {
    const itemOffset = inner.indexOf(item, cursor);
    const occurrence = detectLeadingTag(item, {
      line: position.line,
      column: position.column + offset + 1 + itemOffset,
    });
    if (occurrence !== undefined) occurrences.push(occurrence);
    cursor = itemOffset + item.length + 1;
  }
  return occurrences;
};

/** Throws LandofileParseError on tabs/oversize, exactly like parseYaml does. */
export const detectLandofileTags: (options: {
  readonly content: string;
  readonly file: string;
}) => ReadonlyArray<LandofileTagOccurrence> = ({ content, file }) => {
  assertContentSize(content, file, DEFAULT_MAX_CONTENT_BYTES);
  const occurrences: LandofileTagOccurrence[] = [];

  // YAML 1.2 reserves a leading unquoted `!` for tags. Match compose-go's
  // exact value/sequence-item tags without treating mapping keys as tags.
  const lines = toLines(content, file);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.text.startsWith("- ")) {
      const sequenceValue = line.text.slice(2);
      const sequenceColumn = line.indent + 3;
      occurrences.push(...detectTagsInValue(sequenceValue, { line: line.line, column: sequenceColumn }));

      const sequenceEntry = splitMappingEntry(sequenceValue);
      if (sequenceEntry !== undefined) {
        occurrences.push(
          ...detectTagsInValue(sequenceEntry.rawValue, {
            line: line.line,
            column: sequenceColumn + sequenceEntry.rawKey.length + 1,
          }),
        );
        if (BLOCK_SCALAR_HEADER.test(sequenceEntry.rawValue.trim())) {
          const [, nextIndex] = parseBlockScalar(
            lines,
            file,
            index,
            { ...line, indent: line.indent + 2 },
            sequenceEntry.rawValue.trim(),
          );
          index = nextIndex - 1;
        }
      } else if (BLOCK_SCALAR_HEADER.test(sequenceValue.trim())) {
        const [, nextIndex] = parseBlockScalar(lines, file, index, line, sequenceValue.trim());
        index = nextIndex - 1;
      }
      continue;
    }

    const entry = splitMappingEntry(line.text, { compactValue: true });
    if (entry === undefined) continue;
    occurrences.push(
      ...detectTagsInValue(entry.rawValue, {
        line: line.line,
        column: line.indent + entry.rawKey.length + 2,
      }),
    );
    if (BLOCK_SCALAR_HEADER.test(entry.rawValue.trim())) {
      const [, nextIndex] = parseBlockScalar(lines, file, index, line, entry.rawValue.trim());
      index = nextIndex - 1;
    }
  }

  return occurrences;
};

const BLOCK_SCALAR_HEADER = /^([|>])([+-]?)$/;

const parseBlockScalar = (
  lines: ReadonlyArray<ParsedLine>,
  filePath: string,
  index: number,
  header: ParsedLine,
  indicator: string,
): readonly [string, number] => {
  const match = indicator.match(BLOCK_SCALAR_HEADER);
  if (match === null)
    throw parseError(filePath, `Malformed block scalar at line ${header.line}`, header.line);
  const style = match[1];
  const chomping = match[2];
  const source = header.sourceLines;
  const content: string[] = [];
  let contentIndent: number | undefined;
  let cursor = header.line;
  while (cursor < source.length) {
    const raw = source[cursor] ?? "";
    if (raw.trim() === "") {
      content.push("");
      cursor += 1;
      continue;
    }
    const lineIndent = raw.match(/^ */)?.[0].length ?? 0;
    if (lineIndent <= header.indent) break;
    contentIndent ??= lineIndent;
    if (lineIndent < contentIndent) {
      throw parseError(
        filePath,
        `Malformed YAML indentation at line ${cursor + 1}`,
        cursor + 1,
        lineIndent + 1,
      );
    }
    content.push(raw.slice(contentIndent));
    cursor += 1;
  }

  const finalBreak = content.length > 0 && (cursor < source.length || source.at(-1) === "");
  if (cursor === source.length && source.at(-1) === "" && content.at(-1) === "") content.pop();
  let trailingBlank = 0;
  while (content.at(-1) === "") {
    content.pop();
    trailingBlank += 1;
  }
  let body = "";
  if (style === "|") {
    body = content.join("\n");
  } else {
    let position = 0;
    while (position < content.length) {
      const current = content[position] ?? "";
      if (current === "") {
        body += "\n";
        position += 1;
        continue;
      }
      body += current;
      let blanks = 0;
      while (content[position + 1 + blanks] === "") blanks += 1;
      const next = content[position + 1 + blanks];
      if (next !== undefined) {
        const moreIndented = current.startsWith(" ") || next.startsWith(" ");
        body += blanks > 0 ? "\n".repeat(blanks + (moreIndented ? 1 : 0)) : moreIndented ? "\n" : " ";
      }
      position += blanks + 1;
    }
  }
  const suffix =
    chomping === "+"
      ? "\n".repeat(trailingBlank + (content.length > 0 && finalBreak ? 1 : 0))
      : content.length === 0 || !finalBreak || chomping === "-"
        ? ""
        : "\n";
  let nextIndex = index + 1;
  while (nextIndex < lines.length && (lines[nextIndex]?.line ?? Number.POSITIVE_INFINITY) <= cursor)
    nextIndex += 1;
  return [body + suffix, nextIndex];
};

const parseMap = (
  lines: ReadonlyArray<ParsedLine>,
  filePath: string,
  start: number,
  indent: number,
  depth: number,
  maxDepth: number,
  references: YamlReferenceState,
): readonly [Record<string, unknown>, number] => {
  const startLine = lines[start];
  if (startLine !== undefined) assertDepth(filePath, startLine.line, depth, maxDepth);

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

    const entry = splitMappingEntry(line.text, { compactValue: true });
    if (entry === undefined) {
      throw parseError(filePath, `Malformed YAML at line ${line.line}`, line.line, 1);
    }

    const { rawValue } = entry;
    const valueColumn = line.indent + entry.rawKey.length + 2;
    if (BLOCK_SCALAR_HEADER.test(rawValue.trim())) {
      const [value, nextIndex] = parseBlockScalar(lines, filePath, index, line, rawValue.trim());
      assignKeyedValue(references, result, entry, value, { line: line.line, column: valueColumn }, undefined);
      index = nextIndex;
      continue;
    }
    const reference = parseYamlReferenceSyntax(rawValue, { line: line.line, column: valueColumn });
    const blockAnchor = reference.kind === "anchor" && reference.value === "" ? reference : undefined;
    if (blockAnchor !== undefined) reserveYamlAnchor(references, blockAnchor);

    if (rawValue.trim() === "" || blockAnchor !== undefined) {
      const next = lines[index + 1];
      const location = { line: line.line, column: valueColumn };
      if (next === undefined || next.indent <= line.indent) {
        assignKeyedValue(references, result, entry, {}, location, blockAnchor?.name);
        index += 1;
        continue;
      }
      if (next.text.startsWith("- ")) {
        const [items, nextIndex] = parseList(
          lines,
          filePath,
          index + 1,
          next.indent,
          depth + 1,
          maxDepth,
          references,
        );
        assignKeyedValue(references, result, entry, items, location, blockAnchor?.name);
        index = nextIndex;
        continue;
      }
      const [nested, nextIndex] = parseMap(
        lines,
        filePath,
        index + 1,
        next.indent,
        depth + 1,
        maxDepth,
        references,
      );
      assignKeyedValue(references, result, entry, nested, location, blockAnchor?.name);
      index = nextIndex;
      continue;
    }

    const value = parseScalar(rawValue, filePath, line.line, valueColumn, depth, maxDepth, references);
    assignKeyedValue(references, result, entry, value, { line: line.line, column: valueColumn }, undefined);
    index += 1;
  }

  return [result, index];
};

const parseList = (
  lines: ReadonlyArray<ParsedLine>,
  filePath: string,
  start: number,
  indent: number,
  depth: number,
  maxDepth: number,
  references: YamlReferenceState,
): readonly [ReadonlyArray<unknown>, number] => {
  const startLine = lines[start];
  if (startLine !== undefined) assertDepth(filePath, startLine.line, depth, maxDepth);

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

    const rawItem = line.text.slice(2);
    const value = rawItem.trim();
    const valueColumn = line.indent + 3 + (rawItem.length - rawItem.trimStart().length);
    const reference = parseYamlReferenceSyntax(value, { line: line.line, column: valueColumn });
    const blockAnchor = reference.kind === "anchor" && reference.value === "" ? reference : undefined;
    if (blockAnchor !== undefined) {
      reserveYamlAnchor(references, blockAnchor);
      const next = lines[index + 1];
      if (next === undefined || next.indent <= line.indent) {
        const anchored = {};
        bindYamlAnchor(references, blockAnchor.name, anchored);
        result.push(anchored);
        index += 1;
        continue;
      }
      const [anchored, nextIndex] = next.text.startsWith("- ")
        ? parseList(lines, filePath, index + 1, next.indent, depth + 1, maxDepth, references)
        : parseMap(lines, filePath, index + 1, next.indent, depth + 1, maxDepth, references);
      bindYamlAnchor(references, blockAnchor.name, anchored);
      result.push(anchored);
      index = nextIndex;
      continue;
    }
    if (value === "") {
      throw parseError(
        filePath,
        `Only scalar arrays are supported in Landofiles at line ${line.line}`,
        line.line,
      );
    }

    if (BLOCK_SCALAR_HEADER.test(value)) {
      const [scalar, nextIndex] = parseBlockScalar(lines, filePath, index, line, value);
      result.push(scalar);
      index = nextIndex;
      continue;
    }

    const mapEntry = splitMappingEntry(value);
    if (mapEntry !== undefined) {
      const [item, nextIndex] = parseListItemMap(
        lines,
        filePath,
        index,
        line,
        indent + 2,
        mapEntry,
        depth + 1,
        maxDepth,
        references,
      );
      result.push(item);
      index = nextIndex;
      continue;
    }

    result.push(parseScalar(value, filePath, line.line, valueColumn, depth, maxDepth, references));
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
  firstEntry: MappingEntry,
  depth: number,
  maxDepth: number,
  references: YamlReferenceState,
): readonly [Record<string, unknown>, number] => {
  assertDepth(filePath, startLine.line, depth, maxDepth);

  const item: Record<string, unknown> = {};
  let index = startIndex + 1;

  const consumeKey = (entry: MappingEntry, keyLine: number, keyIndent: number): void => {
    const { rawValue } = entry;
    const valueColumn = keyIndent + entry.rawKey.length + 2;
    const location = { line: keyLine, column: valueColumn };
    if (BLOCK_SCALAR_HEADER.test(rawValue.trim())) {
      // Both consumeKey call sites have already stepped index past the key's own line.
      const headerIndex = index - 1;
      const header = lines[headerIndex];
      if (header === undefined) throw parseError(filePath, `Malformed YAML at line ${keyLine}`, keyLine);
      const [value, nextIndex] = parseBlockScalar(
        lines,
        filePath,
        headerIndex,
        { ...header, indent: keyIndent },
        rawValue.trim(),
      );
      assignKeyedValue(references, item, entry, value, location, undefined);
      index = nextIndex;
      return;
    }
    const reference = parseYamlReferenceSyntax(rawValue, location);
    const blockAnchor = reference.kind === "anchor" && reference.value === "" ? reference : undefined;
    if (blockAnchor !== undefined) reserveYamlAnchor(references, blockAnchor);
    if (rawValue.trim() === "" || blockAnchor !== undefined) {
      const next = lines[index];
      if (next === undefined || next.indent <= keyIndent) {
        assignKeyedValue(references, item, entry, {}, location, blockAnchor?.name);
        return;
      }
      if (next.text.startsWith("- ")) {
        const [items, nextIndex] = parseList(
          lines,
          filePath,
          index,
          next.indent,
          depth + 1,
          maxDepth,
          references,
        );
        assignKeyedValue(references, item, entry, items, location, blockAnchor?.name);
        index = nextIndex;
        return;
      }
      const [nested, nextIndex] = parseMap(
        lines,
        filePath,
        index,
        next.indent,
        depth + 1,
        maxDepth,
        references,
      );
      assignKeyedValue(references, item, entry, nested, location, blockAnchor?.name);
      index = nextIndex;
      return;
    }
    const value = parseScalar(rawValue, filePath, keyLine, valueColumn, depth, maxDepth, references);
    assignKeyedValue(references, item, entry, value, location, undefined);
  };

  consumeKey(firstEntry, startLine.line, childIndent);

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

    const entry = splitMappingEntry(line.text, { compactValue: true });
    if (entry === undefined) {
      throw parseError(filePath, `Malformed YAML at line ${line.line}`, line.line, 1);
    }
    index += 1;
    consumeKey(entry, line.line, childIndent);
  }

  return [item, index];
};

const parseYaml = ({ content, file, limits }: ParseOptions): unknown => {
  const maxContentBytes = limits?.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  assertContentSize(content, file, maxContentBytes);

  const maxDepth = limits?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const lines = toLines(content, file);
  const references = makeYamlReferenceState(file);
  const [parsed, index] = parseMap(lines, file, 0, 0, 1, maxDepth, references);
  if (index < lines.length) {
    const line = lines[index];
    if (line !== undefined) {
      throw parseError(file, `Malformed YAML at line ${line.line}`, line.line, 1);
    }
  }
  return resolveYamlReferences(references, parsed, content.length, maxDepth);
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
