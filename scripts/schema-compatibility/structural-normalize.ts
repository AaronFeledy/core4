import { type JsonSchema, type JsonValue, isJsonObject, jsonEquals, jsonValueKey } from "./model.ts";

const scalarChecks = new Set([
  "type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format", "enum", "const",
]);

const emptySchema = (value: JsonValue | undefined): boolean =>
  value === true || (isJsonObject(value) && Object.keys(value).length === 0);

/** Canonicalize only identities whose accepted JSON values are unchanged. */
export const normalizeStructure = (schema: JsonSchema): JsonSchema => {
  const result: Record<string, JsonValue> = { ...schema };
  for (const key of ["required", "properties", "patternProperties", "dependentSchemas"]) {
    const value = result[key];
    if ((Array.isArray(value) && value.length === 0) || (isJsonObject(value) && Object.keys(value).length === 0)) {
      Reflect.deleteProperty(result, key);
    }
  }
  for (const key of ["additionalProperties", "additionalItems", "items"]) {
    if (emptySchema(result[key])) Reflect.deleteProperty(result, key);
  }
  if (typeof result.pattern === "string") {
    // JSON Schema patterns are strings, not slash-delimited regex literals.
    const pattern = result.pattern;
    let canonical = "";
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\" && index + 1 < pattern.length) {
        const escaped = pattern[++index];
        canonical += escaped === "/" ? "/" : `\\${escaped}`;
      } else canonical += char;
    }
    result.pattern = canonical;
  }
  if (Array.isArray(result.items) && result.additionalItems === false) {
    const limit = result.items.length;
    result.maxItems = typeof result.maxItems === "number" ? Math.min(result.maxItems, limit) : limit;
    Reflect.deleteProperty(result, "additionalItems");
  }
  const patterns = result.patternProperties;
  if (isJsonObject(patterns) && Object.keys(patterns).length === 1 && patterns[""] !== undefined && result.properties === undefined) {
    result.additionalProperties = patterns[""];
    Reflect.deleteProperty(result, "patternProperties");
    if (emptySchema(result.additionalProperties)) Reflect.deleteProperty(result, "additionalProperties");
  }
  if (Array.isArray(result.type)) {
    const types = result.type;
    Reflect.deleteProperty(result, "type");
    // A type array is a union, intersected with the other sibling constraints.
    result.anyOf = types.map((type) => ({ type }));
    if (schema.anyOf !== undefined) {
      result.allOf = [...(Array.isArray(result.allOf) ? result.allOf : []), { anyOf: schema.anyOf }];
    }
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf.flatMap((child) =>
      isJsonObject(child) && Object.keys(child).length === 1 && Array.isArray(child.anyOf)
        ? child.anyOf : [child],
    );
    result.anyOf = [...new Map(branches.map((child) => [jsonValueKey(child), child])).values()]
      .sort((a, b) => jsonValueKey(a).localeCompare(jsonValueKey(b)));
  }
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf.filter((child) => !emptySchema(child));
    Reflect.deleteProperty(result, "allOf");
    const retained: JsonValue[] = [];
    for (const child of branches) {
      if (!isJsonObject(child)) {
        retained.push(child);
        continue;
      }
      // Never move object/array applicators across an allOf scope: in particular,
      // additionalProperties sees only properties declared in its own subschema.
      const keys = Object.keys(child);
      const properties = result.properties;
      const recordIntersection = keys.every((key) => key === "type" || key === "additionalProperties") &&
        child.type === "object" && result.type === "object" && child.additionalProperties !== undefined &&
        result.additionalProperties === undefined && result.patternProperties === undefined &&
        isJsonObject(properties) && Object.values(properties).every((property) => jsonEquals(property, child.additionalProperties));
      const canMerge = recordIntersection || (Object.keys(result).length === 0 && child.allOf === undefined) || keys.every((key) =>
        scalarChecks.has(key) && (result[key] === undefined || jsonEquals(result[key], child[key])),
      );
      if (canMerge) Object.assign(result, child);
      else retained.push(child);
    }
    if (retained.length > 0) result.allOf = retained;
  }
  if (Array.isArray(result.anyOf) && result.anyOf.length === 1 && Object.keys(result).length === 1) {
    const child = result.anyOf[0];
    if (isJsonObject(child)) return child;
  }
  return result;
};
