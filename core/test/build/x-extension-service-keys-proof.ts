import { type JsonSchema, isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import delta from "./fixtures/x-extension-service-keys.delta.json";

export const SERVICE_KEY_PATTERN = delta.propertyNames.pattern;

const evolveServiceMap = (schema: JsonSchema): JsonSchema => {
  if (Array.isArray(schema.anyOf)) {
    return {
      ...schema,
      anyOf: schema.anyOf.map((branch) => (isJsonObject(branch) ? evolveServiceMap(branch) : branch)),
    };
  }
  const fields = schema.properties;
  if (
    isJsonObject(fields) &&
    jsonEquals(fields._tag, { type: "string", enum: ["LandofileOverride"] }) &&
    isJsonObject(fields.value)
  ) {
    return { ...schema, properties: { ...fields, value: evolveServiceMap(fields.value) } };
  }
  if (
    schema.type === "object" &&
    isJsonObject(schema.additionalProperties) &&
    Object.keys(schema).every((key) => key === "type" || key === "additionalProperties")
  ) {
    return { ...schema, propertyNames: delta.propertyNames };
  }
  return schema;
};

export const evolveHistoricalServiceKeys = (
  historical: JsonSchema,
  embedding: "landofile" | "services" | "input" = "landofile",
): JsonSchema => {
  const path =
    embedding === "input"
      ? ["properties", "currentLowerV4Fragments", "items", "properties", "fragment", "properties", "services"]
      : embedding === "landofile"
        ? ["properties", "services"]
        : [];
  const visit = (value: JsonSchema, remaining: readonly string[]): JsonSchema => {
    const [key, ...rest] = remaining;
    if (key === undefined) return evolveServiceMap(value);
    if (Array.isArray(value.anyOf)) {
      return {
        ...value,
        anyOf: value.anyOf.map((branch) => (isJsonObject(branch) ? visit(branch, remaining) : branch)),
      };
    }
    const child = value[key];
    return isJsonObject(child) ? { ...value, [key]: visit(child, rest) } : value;
  };
  return normalizeJsonSchema(visit(historical, path));
};
