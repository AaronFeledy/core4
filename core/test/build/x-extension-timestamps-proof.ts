import { resolve } from "node:path";

import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const timestampsDelta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-timestamps.delta.json")).json(),
);

/** Replay only the reviewed optional field addition, after shorthand evolution. */
export const evolveHistoricalTimestamps = (
  historical: JsonSchema,
  projection: "bare" | "authoring",
): JsonSchema => {
  const keys = timestampsDelta.logSourceInputKeys;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    throw new Error("logSourceInputKeys must be a string array");
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
    const id = properties.id;
    const timestamps =
      projection === "bare"
        ? timestampsDelta.bareTimestamps
        : isJsonObject(id) && Array.isArray(id.anyOf)
          ? timestampsDelta.directiveTimestamps
          : timestampsDelta.authoringTimestamps;
    next.properties = { ...properties, timestamps: wireObject(timestamps) };
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
