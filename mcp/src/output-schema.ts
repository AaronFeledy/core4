import { type JsonSchemaName, getJsonSchema } from "@lando/sdk/schema";
import { Schema } from "effect";

// Compare the complete subtree, including referenced definitions, before naming a
// resource. A matching title or $ref name alone does not establish schema identity.
const fingerprint = (
  node: Schema.Json,
  definitions: Schema.JsonObject,
  seen: readonly string[] = [],
): string => {
  if (Array.isArray(node)) return `[${node.map((item) => fingerprint(item, definitions, seen)).join(",")}]`;
  if (!Schema.is(Schema.JsonObject)(node)) return JSON.stringify(node);
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
    const name = node.$ref.slice(8);
    const target = definitions[name];
    if (target !== undefined && !seen.includes(name)) {
      const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
      return fingerprint(
        { ...(Schema.is(Schema.JsonObject)(target) ? target : {}), ...siblings },
        definitions,
        [...seen, name],
      );
    }
  }
  return `{${Object.keys(node)
    .filter((key) => key !== "$schema" && key !== "$defs")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${fingerprint(node[key] ?? null, definitions, seen)}`)
    .join(",")}}`;
};

let resources: readonly { readonly name: JsonSchemaName; readonly fingerprint: string }[] | undefined;
const resourceFor = (node: Schema.JsonObject, definitions: Schema.JsonObject): string | undefined => {
  resources ??= (["ServiceInfo", "LandofileShape", "StartedService", "CheckResult"] as const).map((name) => {
    const schema = Schema.decodeUnknownSync(Schema.JsonObject)(getJsonSchema(name));
    return {
      name,
      fingerprint: fingerprint(schema, Schema.is(Schema.JsonObject)(schema.$defs) ? schema.$defs : {}),
    };
  });
  const identity = fingerprint(node, definitions);
  return resources.find((resource) => resource.fingerprint === identity)?.name;
};

/** A widening projection: retain first-level shape, never constrain summarized contents. */
export const compactOutputSchema = (schema: Schema.JsonObject): Schema.JsonObject => {
  const definitions = Schema.is(Schema.JsonObject)(schema.$defs) ? schema.$defs : {};
  const project = (value: Schema.Json, depth: number, seen: readonly string[] = []): Schema.Json => {
    if (!Schema.is(Schema.JsonObject)(value)) return value;
    if (typeof value.$ref === "string") {
      const name = value.$ref.startsWith("#/$defs/") ? value.$ref.slice(8) : undefined;
      const target = name === undefined ? undefined : definitions[name];
      // An unresolved/recursive reference must widen, not leave a dangling ref.
      if (name === undefined || target === undefined || seen.includes(name)) return {};
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      return project({ ...(Schema.is(Schema.JsonObject)(target) ? target : {}), ...siblings }, depth, [
        ...seen,
        name,
      ]);
    }
    const projected: Record<string, Schema.Json> = {};
    for (const key of ["type", "enum", "const", "description"] as const) {
      if (value[key] !== undefined) projected[key] = value[key];
    }
    // anyOf remains inclusive when its branches widen. oneOf cannot safely do so.
    if (Array.isArray(value.anyOf))
      projected.anyOf = value.anyOf.map((branch) => project(branch, Math.max(depth, 1), seen));
    if (Array.isArray(value.oneOf))
      projected.anyOf = value.oneOf.map((branch) => project(branch, Math.max(depth, 1), seen));
    if (value.type === "array" && value.items !== undefined && !Array.isArray(value.items)) {
      projected.items = project(value.items, depth, seen);
    }
    if (value.type === "object" || Schema.is(Schema.JsonObject)(value.properties)) {
      if (depth > 0 && Schema.is(Schema.JsonObject)(value.properties)) {
        projected.properties = Object.fromEntries(
          Object.entries(value.properties)
            .filter(([key]) => depth !== 2 || key !== "trace")
            .map(([key, property]) => [key, project(property, depth - 1, seen)]),
        );
        if (Array.isArray(value.required))
          projected.required = value.required.filter((key) => depth !== 2 || key !== "trace");
      } else {
        const resource = resourceFor(value, definitions);
        projected.description = [
          value.description,
          "Nested contents omitted from MCP tool discovery.",
          ...(resource === undefined
            ? []
            : [`Full JSON Schema: read MCP resource lando://schemas/${resource}`]),
        ]
          .filter((part) => typeof part === "string")
          .join(" ");
      }
    }
    return projected;
  };
  // Dispatch constructs envelopes without trace; this only changes discovery.
  return Schema.decodeUnknownSync(Schema.JsonObject)(project(schema, 2));
};
