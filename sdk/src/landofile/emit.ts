import { Either } from "effect";

import { LandofileEmitError } from "./errors.ts";

const INDENT = "  ";

/**
 * Options for {@link emitLandofileYaml} / {@link emitLandofileYamlEither}.
 */
export interface EmitLandofileOptions {
  /**
   * Emit map keys in ascending lexicographic order instead of insertion order.
   * Defaults to `false`, preserving construction order with no behavior change.
   * Array element order is never reordered. Canonical-write call sites may opt
   * into sorted output for stabler diffs.
   */
  readonly sortKeys?: boolean;
}

interface EmitState {
  readonly sortKeys: boolean;
  // Tracks the plain objects currently on the recursion stack so a cyclic
  // structure fails loudly instead of recursing forever.
  readonly seen: WeakSet<object>;
}

// Keys are emitted verbatim, so they must round-trip through the block-style
// parser's key matcher (`^([A-Za-z0-9_.-]+):`). A key outside this shape would
// emit unparseable YAML, so it is rejected rather than silently corrupted.
const KEY_SHAPE = /^[A-Za-z0-9_.-]+$/u;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  // Only literal records (and null-prototype records) are emittable maps. Dates,
  // RegExps, Maps, class instances, and other exotic objects are rejected.
  return proto === Object.prototype || proto === null;
};

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

const emitScalar = (value: unknown, path: string): string => {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LandofileEmitError({
        message: `Cannot emit non-finite number ${String(value)} at ${path} in a Landofile.`,
      });
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (value !== "" && BARE_SAFE.test(value) && !RESERVED.has(value) && !NUMBER_LIKE.test(value)) {
      return value;
    }
    return quoteScalar(value);
  }
  throw new LandofileEmitError({
    message: `Cannot emit value of type ${typeof value} at ${path} in a Landofile.`,
  });
};

const childPath = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

// One traversal helper so every key-write path validates keys and honors
// `sortKeys` identically. Symbol-keyed records are rejected because their
// hidden members would be silently dropped, breaking the round-trip law.
const entriesOf = (
  object: Record<string, unknown>,
  path: string,
  state: EmitState,
): Array<[string, unknown]> => {
  for (const symbolKey of Object.getOwnPropertySymbols(object)) {
    throw new LandofileEmitError({
      message: `Cannot emit symbol key ${String(symbolKey)} at ${path === "" ? "<root>" : path} in a Landofile.`,
    });
  }
  const entries = Object.entries(object);
  for (const [key] of entries) {
    if (!KEY_SHAPE.test(key)) {
      throw new LandofileEmitError({
        message: `Cannot emit map key ${JSON.stringify(key)} at ${path === "" ? "<root>" : path} in a Landofile; keys must match ${KEY_SHAPE.source}.`,
      });
    }
  }
  if (state.sortKeys) {
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return entries;
};

const enterObject = (value: Record<string, unknown>, path: string, state: EmitState): void => {
  if (state.seen.has(value)) {
    throw new LandofileEmitError({
      message: `Cannot emit a cyclic structure at ${path === "" ? "<root>" : path} in a Landofile.`,
    });
  }
  state.seen.add(value);
};

const assertEmptyMapIsEmittable = (value: Record<string, unknown>, path: string, state: EmitState): void => {
  entriesOf(value, path, state);
};

const emitMapEntries = (
  object: Record<string, unknown>,
  indent: number,
  lines: Array<string>,
  path: string,
  state: EmitState,
): void => {
  enterObject(object, path, state);
  const pad = INDENT.repeat(indent);
  for (const [key, value] of entriesOf(object, path, state)) {
    const keyPath = childPath(path, key);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      emitArrayItems(value, indent + 1, lines, keyPath, state);
      continue;
    }
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        assertEmptyMapIsEmittable(value, keyPath, state);
        lines.push(`${pad}${key}: {}`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      emitMapEntries(value, indent + 1, lines, keyPath, state);
      continue;
    }
    lines.push(`${pad}${key}: ${emitScalar(value, keyPath)}`);
  }
  state.seen.delete(object);
};

const emitListItemMap = (
  item: Record<string, unknown>,
  itemIndent: number,
  lines: Array<string>,
  path: string,
  state: EmitState,
): void => {
  enterObject(item, path, state);
  const pad = INDENT.repeat(itemIndent);
  const entries = entriesOf(item, path, state);
  const [firstKey, firstValue] = entries[0] as [string, unknown];
  const firstPath = childPath(path, firstKey);

  if (Array.isArray(firstValue)) {
    if (firstValue.length === 0) {
      lines.push(`${pad}- ${firstKey}: []`);
    } else {
      lines.push(`${pad}- ${firstKey}:`);
      emitArrayItems(firstValue, itemIndent + 2, lines, firstPath, state);
    }
  } else if (isPlainObject(firstValue)) {
    if (Object.keys(firstValue).length === 0) {
      assertEmptyMapIsEmittable(firstValue, firstPath, state);
      lines.push(`${pad}- ${firstKey}: {}`);
    } else {
      lines.push(`${pad}- ${firstKey}:`);
      emitMapEntries(firstValue, itemIndent + 2, lines, firstPath, state);
    }
  } else {
    lines.push(`${pad}- ${firstKey}: ${emitScalar(firstValue, firstPath)}`);
  }

  for (const [key, value] of entries.slice(1)) {
    emitMapEntries({ [key]: value }, itemIndent + 1, lines, path, state);
  }
  state.seen.delete(item);
};

const emitArrayItems = (
  array: ReadonlyArray<unknown>,
  itemIndent: number,
  lines: Array<string>,
  path: string,
  state: EmitState,
): void => {
  const pad = INDENT.repeat(itemIndent);
  for (const [index, item] of array.entries()) {
    const itemPath = `${path}[${index}]`;
    if (Array.isArray(item)) {
      throw new LandofileEmitError({
        message: `Cannot emit a nested array as a Landofile list item at ${itemPath}.`,
      });
    }
    if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        assertEmptyMapIsEmittable(item, itemPath, state);
        lines.push(`${pad}- {}`);
        continue;
      }
      emitListItemMap(item, itemIndent, lines, itemPath, state);
      continue;
    }
    lines.push(`${pad}- ${emitScalar(item, itemPath)}`);
  }
};

/**
 * Serialize a canonical Landofile object (or a `Partial<LandofileShape>`
 * fragment) to the block-style YAML subset that `parseLandofile` round-trips.
 *
 * The input is the **encoded (wire) form** of a Landofile — the merged tree of
 * plain records, arrays, strings, finite numbers, booleans, and `null`, i.e.
 * `LandofileShape.Encoded`, not a decoded runtime `LandofileShape.Type` whose
 * leaves may be branded or `DateTime` values. Strings that would otherwise parse
 * as a number, boolean, `null`, or that carry structural characters are quoted
 * so the emitted text re-parses to the exact same value.
 *
 * Throws {@link LandofileEmitError} on a non-emittable input: a map key outside
 * `^[A-Za-z0-9_.-]+$`, a non-finite number, an unsupported value type
 * (`undefined`, `bigint`, symbol, function, `Date`, `RegExp`, `Map`, a class
 * instance, or any other non-plain object), a symbol key, a cyclic structure, or
 * a nested array list item.
 *
 * @param value - the encoded Landofile object to serialize.
 * @param options - optional emit controls; see {@link EmitLandofileOptions}.
 */
export const emitLandofileYaml = (value: Record<string, unknown>, options?: EmitLandofileOptions): string => {
  const lines: Array<string> = [];
  const state: EmitState = { sortKeys: options?.sortKeys ?? false, seen: new WeakSet() };
  if (!isPlainObject(value)) {
    throw new LandofileEmitError({
      message: `Cannot emit a Landofile from a ${typeof value === "object" ? "non-plain object" : typeof value} root.`,
    });
  }
  emitMapEntries(value, 0, lines, "", state);
  lines.push("");
  return lines.join("\n");
};

/**
 * The same emit as {@link emitLandofileYaml}, returned as an `Either` for
 * callers that prefer typed handling over a throw. A non-emittable input yields
 * `Either.left(LandofileEmitError)`.
 *
 * @param value - the encoded Landofile object to serialize.
 * @param options - optional emit controls; see {@link EmitLandofileOptions}.
 */
export const emitLandofileYamlEither = (
  value: Record<string, unknown>,
  options?: EmitLandofileOptions,
): Either.Either<string, LandofileEmitError> => {
  try {
    return Either.right(emitLandofileYaml(value, options));
  } catch (cause) {
    if (cause instanceof LandofileEmitError) return Either.left(cause);
    return Either.left(
      new LandofileEmitError({
        message: cause instanceof Error ? cause.message : "Failed to emit Landofile YAML.",
        cause,
      }),
    );
  }
};
