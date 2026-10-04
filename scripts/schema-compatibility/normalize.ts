import { type JsonSchema, type JsonValue, isJsonObject, jsonValueKey } from "./model.ts";
import { normalizeStructure } from "./structural-normalize.ts";

const annotations = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "x-deprecation",
]);
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas"]);
const schemaArrays = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const schemaValues = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
]);

/** Compare reachable constraints, not the generator's definition names or prose. */
export const normalizeJsonSchema = (root: JsonSchema): JsonSchema => {
  const resolve = (ref: string): JsonValue | undefined => {
    if (!ref.startsWith("#/")) return undefined;
    let value: JsonValue | undefined = root;
    for (const segment of ref.slice(2).split("/")) {
      if (!isJsonObject(value)) return undefined;
      value = value[decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return value;
  };
  const visit = (
    schema: JsonSchema,
    ancestors: readonly JsonSchema[],
    aliases: readonly JsonSchema[] = [],
  ): JsonSchema => {
    if (
      typeof schema.$ref === "string" &&
      Object.keys(schema).every(
        (key) => key === "$ref" || key === "$defs" || key === "definitions" || annotations.has(key),
      )
    ) {
      // Alias hops do not change semantic depth. Track them separately so a
      // targetless alias cycle terminates without inventing an accepting schema.
      if (aliases.includes(schema)) return { $ref: schema.$ref };
      const target = resolve(schema.$ref);
      if (isJsonObject(target)) return visit(target, ancestors, [...aliases, schema]);
    }
    const cycle = ancestors.indexOf(schema);
    if (cycle >= 0) return { $ref: `#cycle/${ancestors.length - cycle}` };
    const stack = [...ancestors, schema];
    const result: Record<string, JsonValue> = {};
    if (typeof schema.$ref === "string") {
      const target = resolve(schema.$ref);
      if (isJsonObject(target)) Object.assign(result, visit(target, stack));
      else result.$ref = schema.$ref;
    }
    for (const key of Object.keys(schema).sort()) {
      if (annotations.has(key) || key === "$defs" || key === "definitions" || key === "$ref") continue;
      const value = schema[key];
      if (value === undefined) continue;
      if (schemaMaps.has(key) && isJsonObject(value)) {
        result[key] = Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => {
              const child = value[name];
              return [name, isJsonObject(child) ? visit(child, stack) : (child ?? null)];
            }),
        );
      } else if (Array.isArray(value) && (schemaArrays.has(key) || key === "items")) {
        const children = value.map((child) => (isJsonObject(child) ? visit(child, stack) : child));
        result[key] =
          key === "items" || key === "prefixItems"
            ? children
            : children.sort((a, b) => jsonValueKey(a).localeCompare(jsonValueKey(b)));
      } else if (schemaValues.has(key) && isJsonObject(value)) {
        result[key] = visit(value, stack);
      } else if ((key === "enum" || key === "required" || key === "type") && Array.isArray(value)) {
        result[key] = [...value].sort((a, b) => jsonValueKey(a).localeCompare(jsonValueKey(b)));
      } else result[key] = value;
    }
    return normalizeStructure(
      result,
      ancestors.some((parent) => parent.unevaluatedProperties !== undefined),
    );
  };
  return visit(root, []);
};
