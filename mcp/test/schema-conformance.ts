import { Schema } from "effect";

const isObject = Schema.is(Schema.JsonObject);

// This walker covers every assertion keyword emitted by the MCP projection.
// Fail on an unfamiliar keyword so adding constraints cannot silently skip QA.
export const conforms = (schema: Schema.Json, value: Schema.Json): boolean => {
  if (typeof schema === "boolean") return schema;
  if (!isObject(schema)) return false;
  for (const key of Object.keys(schema)) {
    if (!["type", "properties", "required", "enum", "const", "anyOf", "items", "description"].includes(key)) {
      throw new TypeError(`Unsupported compact schema keyword: ${key}`);
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => conforms(branch, value))) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return false;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      !types.some((type) => {
        switch (type) {
          case "object":
            return isObject(value);
          case "array":
            return Array.isArray(value);
          case "null":
            return value === null;
          case "integer":
            return typeof value === "number" && Number.isInteger(value);
          case "number":
            return typeof value === "number";
          case "string":
            return typeof value === "string";
          case "boolean":
            return typeof value === "boolean";
          default:
            throw new TypeError(`Unsupported compact schema type: ${type}`);
        }
      })
    )
      return false;
  }
  if (isObject(value)) {
    if (
      Array.isArray(schema.required) &&
      !schema.required.every((key) => typeof key === "string" && Object.hasOwn(value, key))
    )
      return false;
    if (isObject(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        const field = value[key];
        if (field !== undefined && !conforms(child, field)) return false;
      }
    }
  }
  if (
    Array.isArray(value) &&
    schema.items !== undefined &&
    !value.every((item) => conforms(schema.items ?? {}, item))
  )
    return false;
  return true;
};
