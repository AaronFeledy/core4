/**
 * Minimal, dependency-free YAML subset parser shared by `ConfigService`
 * (`core/src/services/config.ts`) and the cold-start root resolver
 * (`core/src/config/roots.ts`).
 *
 * This is the **single source of truth** for how `<userConfRoot>/config.yml` is
 * interpreted. `resolveUserDataRoot` runs on the `lando shellenv` fast path
 * (bootstrap `none`, no Effect runtime), so it
 * cannot import `ConfigService` (that module pulls in Effect). Previously
 * `roots.ts` hand-rolled its own line scanner, which diverged from
 * `parseConfigYaml` on duplicate keys, block-then-scalar, indented keys, and
 * YAML `null` — recreating the very `setup` vs `shellenv` PATH mismatch the
 * config.yml layer was added to fix. Both paths now parse with this module so
 * they cannot disagree.
 *
 * This module deliberately imports nothing from `@lando/sdk` (its error barrel
 * pulls Effect) — it throws a plain {@link MinimalYamlError} that callers map to
 * their own error type.
 */

/** Plain (Effect-free) parse failure; callers map it to a domain error. */
export class MinimalYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinimalYamlError";
  }
}

export const parseScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      throw new MinimalYamlError(`Unsupported YAML value: ${trimmed}`);
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

interface ParsedLine {
  readonly indent: number;
  readonly line: number;
  readonly text: string;
}

const toLines = (text: string): ReadonlyArray<ParsedLine> => {
  const lines: ParsedLine[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    const trimmedLine = withoutComment.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;
    lines.push({ indent: withoutComment.match(/^ */)?.[0].length ?? 0, line: index + 1, text: trimmedLine });
  }
  return lines;
};

const parseList = (
  lines: ReadonlyArray<ParsedLine>,
  start: number,
  indent: number,
): readonly [ReadonlyArray<unknown>, number] => {
  const result: unknown[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) throw new MinimalYamlError(`Malformed YAML indentation at line ${line.line}`);
    if (!line.text.startsWith("- ")) break;

    const value = line.text.slice(2).trim();
    if (value === "") throw new MinimalYamlError(`Malformed YAML at line ${line.line}`);
    const mapMatch = value.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
    if (mapMatch !== null) {
      const [, firstKey, firstRawValueRaw] = mapMatch as [string, string, string?];
      const item: Record<string, unknown> = {};
      item[firstKey] = parseScalar(firstRawValueRaw ?? "");
      index += 1;
      while (index < lines.length) {
        const child = lines[index];
        if (child === undefined || child.indent <= indent) break;
        if (child.text.startsWith("- ")) break;
        if (child.indent !== indent + 2)
          throw new MinimalYamlError(`Malformed YAML indentation at line ${child.line}`);
        const childMatch = child.text.match(/^([A-Za-z0-9_.-]+):(.*)$/);
        if (childMatch === null) throw new MinimalYamlError(`Malformed YAML at line ${child.line}`);
        const [, childKey, childRawValue] = childMatch as [string, string, string];
        item[childKey] = parseScalar(childRawValue);
        index += 1;
      }
      result.push(item);
      continue;
    }

    result.push(parseScalar(value));
    index += 1;
  }
  return [result, index];
};

const parseMap = (
  lines: ReadonlyArray<ParsedLine>,
  start: number,
  indent: number,
): readonly [Record<string, unknown>, number] => {
  const root: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) throw new MinimalYamlError(`Malformed YAML indentation at line ${line.line}`);
    if (line.text.startsWith("- ")) break;

    const match = line.text.match(/^([A-Za-z0-9_.-]+):(.*)$/);
    if (match === null) throw new MinimalYamlError(`Malformed YAML at line ${line.line}`);

    const [, key, rawValue] = match as [string, string, string];
    if (rawValue.trim() === "") {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= line.indent) {
        root[key] = {};
        index += 1;
        continue;
      }
      if (next.text.startsWith("- ")) {
        const [items, nextIndex] = parseList(lines, index + 1, next.indent);
        root[key] = items;
        index = nextIndex;
        continue;
      }
      const [nested, nextIndex] = parseMap(lines, index + 1, next.indent);
      root[key] = nested;
      index = nextIndex;
      continue;
    }

    root[key] = parseScalar(rawValue);
    index += 1;
  }
  return [root, index];
};

export const parseMinimalYaml = (text: string): Record<string, unknown> => {
  const lines = toLines(text);
  const [parsed, index] = parseMap(lines, 0, 0);
  if (index < lines.length) {
    const line = lines[index];
    if (line !== undefined) throw new MinimalYamlError(`Malformed YAML at line ${line.line}`);
  }
  return parsed;
};
