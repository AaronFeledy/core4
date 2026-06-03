const INDENT = "  ";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const NUMBER_LIKE = /^-?\d+(?:\.\d+)?$/u;
const BARE_SAFE = /^[A-Za-z0-9._~:/@+-]+$/u;
const RESERVED = new Set(["true", "false", "null"]);

const quoteScalar = (value: string): string => {
  const escaped = value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t");
  return `"${escaped}"`;
};

const emitScalar = (value: unknown): string => {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot emit non-finite number ${String(value)} in a Landofile.`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (value !== "" && BARE_SAFE.test(value) && !RESERVED.has(value) && !NUMBER_LIKE.test(value)) {
      return value;
    }
    return quoteScalar(value);
  }
  throw new Error(`Cannot emit value of type ${typeof value} in a Landofile.`);
};

const emitMapEntries = (object: Record<string, unknown>, indent: number, lines: Array<string>): void => {
  const pad = INDENT.repeat(indent);
  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      emitArrayItems(value, indent + 1, lines);
      continue;
    }
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${pad}${key}: {}`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      emitMapEntries(value, indent + 1, lines);
      continue;
    }
    lines.push(`${pad}${key}: ${emitScalar(value)}`);
  }
};

const emitListItemMap = (item: Record<string, unknown>, itemIndent: number, lines: Array<string>): void => {
  const pad = INDENT.repeat(itemIndent);
  const entries = Object.entries(item);
  const [firstKey, firstValue] = entries[0] as [string, unknown];

  if (Array.isArray(firstValue)) {
    if (firstValue.length === 0) {
      lines.push(`${pad}- ${firstKey}: []`);
    } else {
      lines.push(`${pad}- ${firstKey}:`);
      emitArrayItems(firstValue, itemIndent + 2, lines);
    }
  } else if (isPlainObject(firstValue)) {
    if (Object.keys(firstValue).length === 0) {
      lines.push(`${pad}- ${firstKey}: {}`);
    } else {
      lines.push(`${pad}- ${firstKey}:`);
      emitMapEntries(firstValue, itemIndent + 2, lines);
    }
  } else {
    lines.push(`${pad}- ${firstKey}: ${emitScalar(firstValue)}`);
  }

  for (const [key, value] of entries.slice(1)) {
    emitMapEntries({ [key]: value }, itemIndent + 1, lines);
  }
};

const emitArrayItems = (array: ReadonlyArray<unknown>, itemIndent: number, lines: Array<string>): void => {
  const pad = INDENT.repeat(itemIndent);
  for (const item of array) {
    if (Array.isArray(item)) {
      throw new Error("Cannot emit a nested array as a Landofile list item.");
    }
    if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      emitListItemMap(item, itemIndent, lines);
      continue;
    }
    lines.push(`${pad}- ${emitScalar(item)}`);
  }
};

/**
 * Serialize a canonical Landofile object to the block-style YAML subset that
 * {@link parseLandofile} round-trips. Strings that would otherwise parse as a
 * number, boolean, `null`, or that carry structural characters are quoted so
 * the emitted text re-parses to the exact same value.
 */
export const emitLandofileYaml = (value: Record<string, unknown>): string => {
  const lines: Array<string> = [];
  emitMapEntries(value, 0, lines);
  lines.push("");
  return lines.join("\n");
};
