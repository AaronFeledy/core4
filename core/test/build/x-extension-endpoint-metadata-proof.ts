import { resolve } from "node:path";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const delta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-endpoint-metadata.delta.json")).json(),
);
if (!Array.isArray(delta.additions)) throw new TypeError("Missing endpoint metadata deltas");
const transitions = delta.additions.map((entry) => {
  const pair = wireObject(entry);
  return { before: wireObject(pair.before), after: wireObject(pair.after) };
});

/** Replay the pinned endpoint additions without accepting other historical graph changes. */
export const evolveHistoricalEndpointMetadata = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const fields = value.properties;
    const endpoint =
      value.type === "object" &&
      value.additionalProperties === false &&
      isJsonObject(fields) &&
      fields._tag !== undefined &&
      fields.port !== undefined &&
      fields.protocol !== undefined &&
      fields.name !== undefined;
    const transition = endpoint ? transitions.find(({ before }) => jsonEquals(value, before)) : undefined;
    if (transition !== undefined) return structuredClone(transition.after);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
