import { resolve } from "node:path";

import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const includeChecksumDelta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-include-checksum.delta.json")).json(),
);

/** Replay only the reviewed IncludeEntry checksum removal onto an already evolved schema graph. */
export const evolveHistoricalIncludeChecksum = (historical: JsonSchema): JsonSchema => {
  const keys = includeChecksumDelta.includeEntryKeys;
  const removed = includeChecksumDelta.removedKey;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    throw new Error("includeEntryKeys must be a string array");
  }
  if (typeof removed !== "string" || !keys.includes(removed)) {
    throw new Error("removedKey must name one of includeEntryKeys");
  }
  const expectedKeys = keys.toSorted();
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = visit(child);
    const properties = next.properties;
    if (value.type !== "object" || value.additionalProperties !== false || !isJsonObject(properties)) {
      return next;
    }
    const actualKeys = Object.keys(properties).sort();
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) {
      return next;
    }
    const { [removed]: _removed, ...kept } = properties;
    next.properties = kept;
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
