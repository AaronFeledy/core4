import { type JsonSchema, Predicate } from "effect";

export const pruneUnusedDefinitions = (document: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const definitions = document.$defs;
  if (!Predicate.isObject(definitions)) return document;
  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!Predicate.isObject(value)) return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
      const segment = value.$ref.slice("#/$defs/".length).split("/")[0];
      if (segment !== undefined) {
        const name = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
        if (!referenced.has(name)) {
          referenced.add(name);
          visit(definitions[name]);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        ["properties", "patternProperties", "$defs", "dependentSchemas"].includes(key) &&
        Predicate.isObject(child)
      ) {
        Object.values(child).forEach(visit);
      } else if (!["const", "enum", "default", "examples"].includes(key)) visit(child);
    }
  };
  const { $defs: _definitions, ...root } = document;
  visit(root);
  for (const name of Object.keys(definitions)) {
    if (!referenced.has(name)) Reflect.deleteProperty(definitions, name);
  }
  if (Object.keys(definitions).length === 0) Reflect.deleteProperty(document, "$defs");
  return document;
};
