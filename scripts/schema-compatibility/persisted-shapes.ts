import { type JsonSchema, type JsonValue, isJsonObject, jsonValueKey } from "./model.ts";
import { normalizeJsonSchema } from "./normalize.ts";

const shallowShapeKey = (schema: JsonSchema, depth = 2): string =>
  jsonValueKey({
    type: schema.type ?? null,
    properties: isJsonObject(schema.properties) ? Object.keys(schema.properties).sort() : null,
    unions: [schema.anyOf, schema.oneOf, schema.allOf].map((members) =>
      Array.isArray(members)
        ? members
            .map((member) => (depth > 0 && isJsonObject(member) ? shallowShapeKey(member, depth - 1) : null))
            .sort()
        : null,
    ),
    items: depth > 0 && isJsonObject(schema.items) ? shallowShapeKey(schema.items, depth - 1) : null,
    additionalProperties:
      depth > 0 && isJsonObject(schema.additionalProperties)
        ? shallowShapeKey(schema.additionalProperties, depth - 1)
        : null,
  });

/** Key every object node reachable from the roots. */
const nodeKeys = (
  roots: ReadonlyArray<JsonValue>,
  keyOf: (node: JsonSchema) => string,
): ReadonlySet<string> => {
  const keys = new Set<string>();
  const pending: JsonValue[] = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) pending.push(...node);
    else if (isJsonObject(node)) {
      keys.add(keyOf(node));
      pending.push(...Object.values(node));
    }
  }
  return keys;
};

export const persistedShallowKeys = (schemas: ReadonlyArray<JsonSchema>): ReadonlySet<string> =>
  nodeKeys(schemas, (node) => shallowShapeKey(node));

export const persistedShapeKeys = (schema: JsonSchema): ReadonlySet<string> =>
  nodeKeys([normalizeJsonSchema(schema)], jsonValueKey);

export const publishedShapeKey = (
  schema: JsonSchema,
  shallowKeys: ReadonlySet<string>,
): string | undefined => {
  if (!shallowKeys.has(shallowShapeKey(schema))) return undefined;
  const normalized = normalizeJsonSchema(schema);
  // Bare scalars and open dictionaries coincide across unrelated domain brands.
  // Their actual persisted names are listed explicitly instead of guessed by shape.
  if (Object.keys(normalized).every((key) => key === "type")) return undefined;
  if (
    normalized.type === "object" &&
    Object.keys(normalized).every((key) => key === "type" || key === "additionalProperties") &&
    (normalized.additionalProperties === true ||
      (isJsonObject(normalized.additionalProperties) &&
        Object.keys(normalized.additionalProperties).length === 0))
  )
    return undefined;
  return jsonValueKey(normalized);
};
