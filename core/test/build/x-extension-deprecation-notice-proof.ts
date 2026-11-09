import { resolve } from "node:path";

import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const deprecationNoticeDelta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-deprecation-notice.delta.json")).json(),
);
const edits = deprecationNoticeDelta.edits;
if (!Array.isArray(edits)) throw new TypeError("Missing reviewed deprecation notice edits");

/** Replay only the reviewed expression-aware notice projection, after every earlier wire evolution. */
export const evolveHistoricalDeprecationNotice = (
  historical: JsonSchema,
  profile: "services" | "fragment" | "input",
): JsonSchema => {
  const reviewed = edits.map((edit) => wireObject(edit));
  const applied = reviewed.map(() => 0);
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = visit(child);
    const properties = next.properties;
    if (!isJsonObject(properties) || properties.deprecated === undefined) return next;
    const index = reviewed.findIndex((edit) => jsonEquals(properties.deprecated, edit.before));
    const after = reviewed[index]?.after;
    if (after === undefined) return next;
    applied[index] = (applied[index] ?? 0) + 1;
    next.properties = { ...properties, deprecated: structuredClone(after) };
    return next;
  };
  const evolved = visit(historical);
  for (const [index, edit] of reviewed.entries()) {
    const expected = wireObject(edit.occurrences)[profile];
    if (applied[index] !== expected) {
      throw new TypeError(
        `Expected reviewed notice edit ${index} ${String(expected)} times in ${profile}, applied ${applied[index]}`,
      );
    }
  }
  return normalizeJsonSchema(wireObject(evolved));
};
