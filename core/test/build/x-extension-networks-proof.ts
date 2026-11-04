import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import delta from "./fixtures/x-extension-networks.delta.json";
import { wireObject } from "./x-extension-wire-proof.ts";

// Reviewed delta: service network attachments retain only aliases and x-* metadata.
// The description change is an annotation, already removed by the lawful normalizer.
/** Replay only the exact pinned network projection, including its complete unions. */
export const evolveHistoricalNetworks = (
  historical: JsonSchema,
  projection: "bare" | "authoring",
): JsonSchema => {
  const transitions = projection === "bare" ? [delta.bare] : [delta.authoring, delta.wireAttachment];
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    // A changed historical constraint must survive, never be erased by this replay.
    const transition = transitions.find(({ before }) => jsonEquals(value, before));
    if (transition !== undefined) return structuredClone(transition.after);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
