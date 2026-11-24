import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { packageCacheDeltas } from "./fixtures/x-extension-package-cache.delta.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

export const evolveHistoricalPackageCache = (historical: JsonSchema): JsonSchema => {
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
      fields.packageCache !== undefined
    )
      return next;
    const delta = packageCacheDeltas.find(({ witness }) => jsonEquals(fields.extraArgs, witness));
    return delta === undefined
      ? next
      : { ...next, properties: { ...fields, packageCache: structuredClone(delta.field) } };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
