import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { noScriptsDeltas } from "./fixtures/x-extension-no-scripts.delta.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const evolveHistoricalNoScripts = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const fields = next.properties;
    if (
      value.type !== "object" ||
      !isJsonObject(fields) ||
      fields.type === undefined ||
      fields.image === undefined ||
      fields.ports === undefined ||
      fields.noScripts !== undefined
    )
      return next;
    const delta = noScriptsDeltas.find(({ witness }) => jsonEquals(fields.consolePort, witness));
    return delta === undefined
      ? next
      : { ...next, properties: { ...fields, noScripts: structuredClone(delta.field) } };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
