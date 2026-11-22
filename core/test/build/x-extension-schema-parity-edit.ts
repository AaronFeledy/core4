import { createHash } from "node:crypto";

import { type JsonValue, isJsonObject, jsonValueKey } from "../../../scripts/schema-compatibility/model.ts";

export type ParityEdit =
  | { readonly replace: JsonValue }
  | { readonly array: ReadonlyArray<number | null> }
  | {
      readonly fields: Readonly<Record<string, number>>;
      readonly add: Readonly<Record<string, JsonValue>>;
      readonly remove: ReadonlyArray<string>;
    };

export const schemaDigest = (value: JsonValue): string =>
  createHash("sha256").update(jsonValueKey(value)).digest("hex");

export const diffParity = (
  before: JsonValue,
  after: JsonValue,
  intern: (edit: ParityEdit) => number,
): number | null => {
  if (before === after) return null;
  if (isJsonObject(before) && isJsonObject(after)) {
    const fields: Record<string, number> = Object.create(null);
    const add: Record<string, JsonValue> = Object.create(null);
    const remove = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
    for (const [key, value] of Object.entries(after)) {
      const previous = before[key];
      if (previous === undefined) add[key] = value;
      else {
        const edit = diffParity(previous, value, intern);
        if (edit !== null) fields[key] = edit;
      }
    }
    return Object.keys(fields).length || Object.keys(add).length || remove.length
      ? intern({ fields, add, remove })
      : null;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    const array = before.map((value, i) => diffParity(value, after[i], intern));
    return array.some((edit) => edit !== null) ? intern({ array }) : null;
  }
  return intern({ replace: after });
};

export const applyParity = (
  before: JsonValue,
  id: number | null,
  edits: ReadonlyArray<ParityEdit>,
): JsonValue => {
  if (id === null) return before;
  const edit = edits[id];
  if (edit === undefined) throw new TypeError(`Missing parity edit ${id}`);
  if ("replace" in edit) return edit.replace;
  if ("array" in edit && Array.isArray(before)) {
    return before.map((value, i) => applyParity(value, edit.array[i] ?? null, edits));
  }
  if ("fields" in edit && isJsonObject(before)) {
    const entries = Object.entries(before)
      .filter(([key]) => !edit.remove.includes(key))
      .map(([key, value]) => [key, applyParity(value, edit.fields[key] ?? null, edits)] as const);
    return Object.fromEntries(
      [...entries, ...Object.entries(edit.add)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  throw new TypeError(`Parity edit ${id} does not match its checkpoint`);
};
