import { type JsonSchema, Predicate, Schema } from "effect";
import { type SchemaNode, localReference } from "./config-key-navigation.ts";
import { pruneUnusedDefinitions } from "./json-schema-definitions.ts";

export const projectKeySchema = (document: JsonSchema.JsonSchema, node: SchemaNode): Schema.Json => {
  const definitions: JsonSchema.JsonSchema = {};
  const references = new Map<string, string>();
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (!Predicate.isObject(value)) return value;
    const output: JsonSchema.JsonSchema = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$defs" || key === "$id") continue;
      if (key === "$ref" && typeof child === "string" && child.startsWith("#")) {
        let reference = references.get(child);
        if (reference === undefined) {
          const pointer = decodeURIComponent(child.slice(1));
          const parts = pointer.split("/");
          const definition =
            parts[1] === "$defs" ? parts[2]?.replace(/~1/g, "/").replace(/~0/g, "~") : undefined;
          let name = definition ?? `__projected_${references.size}`;
          while (
            definition === undefined &&
            (name in definitions || (Predicate.isObject(document.$defs) && name in document.$defs))
          )
            name += "_";
          reference = definition === undefined ? `#/$defs/${name}` : child;
          references.set(child, reference);
          if (!(name in definitions)) {
            definitions[name] = {};
            let target: unknown;
            if (definition === undefined) target = localReference(document, child);
            else if (Predicate.isObject(document.$defs)) target = document.$defs[definition];
            definitions[name] = copy(target);
          }
        }
        output[key] = reference;
      } else if (["const", "enum", "default", "examples"].includes(key)) output[key] = structuredClone(child);
      else if (
        ["properties", "patternProperties", "dependentSchemas"].includes(key) &&
        Predicate.isObject(child)
      )
        output[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, copy(schema)]));
      else output[key] = copy(child);
    }
    return output;
  };
  const projected = copy(typeof node === "boolean" ? (node ? {} : { not: {} }) : node);
  return Schema.decodeUnknownSync(Schema.Json)(
    pruneUnusedDefinitions({
      ...(typeof document.$schema === "string" ? { $schema: document.$schema } : {}),
      ...(Predicate.isObject(projected) ? projected : {}),
      ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
    }),
  );
};
