import { resolve } from "node:path";

import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const includeWhenDelta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-include-when.delta.json")).json(),
);

/** Replay only the reviewed optional include condition, after checksum and authoring evolution. */
export const evolveHistoricalIncludeWhen = (historical: JsonSchema): JsonSchema => {
  const expectedKeySets = [includeWhenDelta.includeEntryKeys, includeWhenDelta.toolingIncludeKeys].map(
    (keys) => {
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
        throw new TypeError("include condition key sets must be string arrays");
      }
      return keys.toSorted();
    },
  );
  const bareWhen = wireObject(includeWhenDelta.bareWhen);
  const authoringWhen = wireObject(includeWhenDelta.authoringWhen);
  const directiveWhen = normalizeJsonSchema({
    ...wireObject(includeWhenDelta.directiveWhen),
    $defs: { When: authoringWhen },
  });
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
    if (
      !expectedKeySets.some(
        (keys) => keys.length === actualKeys.length && keys.every((key, i) => key === actualKeys[i]),
      )
    ) {
      return next;
    }
    const source = properties.source ?? properties.file;
    const alternatives = isJsonObject(source) ? source.anyOf : undefined;
    const directive =
      Array.isArray(alternatives) &&
      alternatives.some(
        (branch) => isJsonObject(branch) && isJsonObject(branch.properties) && "_tag" in branch.properties,
      );
    const when = directive ? directiveWhen : Array.isArray(alternatives) ? authoringWhen : bareWhen;
    next.properties = { ...properties, when };
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
