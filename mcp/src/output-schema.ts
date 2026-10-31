import {
  CheckResult,
  type JsonSchemaName,
  LandofileShape,
  ServiceInfo,
  StartedService,
  getJsonSchema,
} from "@lando/sdk/schema";
import { Predicate, Schema } from "effect";
import * as AST from "effect/SchemaAST";

type JsonRecord = { readonly [key: string]: unknown };

const DEFINITION_REF = "#/$defs/";

const definitionsOf = (schema: JsonRecord): JsonRecord =>
  Predicate.isObject(schema.$defs) ? schema.$defs : {};

const withoutRef = (node: JsonRecord): JsonRecord =>
  Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));

/** Follow one local `$ref`, keeping sibling keywords; undefined when it is unresolved or already visited. */
const resolveRef = (
  node: JsonRecord,
  definitions: JsonRecord,
  seen: readonly string[],
): { readonly name: string; readonly node: JsonRecord } | undefined => {
  if (typeof node.$ref !== "string" || !node.$ref.startsWith(DEFINITION_REF)) return undefined;
  const name = node.$ref.slice(DEFINITION_REF.length);
  const target = definitions[name];
  if (target === undefined || seen.includes(name)) return undefined;
  return { name, node: { ...(Predicate.isObject(target) ? target : {}), ...withoutRef(node) } };
};

// Compare the complete subtree, including referenced definitions, before naming a
// resource. A matching title or $ref name alone does not establish schema identity.
const fingerprint = (node: unknown, definitions: JsonRecord, seen: readonly string[] = []): string => {
  if (Array.isArray(node)) return `[${node.map((item) => fingerprint(item, definitions, seen)).join(",")}]`;
  if (!Predicate.isObject(node)) return JSON.stringify(node);
  const resolved = resolveRef(node, definitions, seen);
  if (resolved !== undefined) return fingerprint(resolved.node, definitions, [...seen, resolved.name]);
  return `{${Object.keys(node)
    .filter((key) => key !== "$schema" && key !== "$defs")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${fingerprint(node[key] ?? null, definitions, seen)}`)
    .join(",")}}`;
};

const sortedKeys = (keys: ReadonlyArray<PropertyKey>): string => keys.map(String).sort().join("\0");

const propertyKeys = (node: JsonRecord): string =>
  Predicate.isObject(node.properties) ? sortedKeys(Object.keys(node.properties)) : "";

interface ResourceCandidate {
  readonly name: JsonSchemaName;
  readonly keys: string;
  readonly fingerprint: () => string;
}

// Key sets come from the schema AST so JSON Schema is generated only for a candidate whose keys match.
const RESOURCES = { ServiceInfo, LandofileShape, StartedService, CheckResult } satisfies Partial<
  Record<JsonSchemaName, Schema.Top>
>;

let candidates: ReadonlyArray<ResourceCandidate> | undefined;
const resourceCandidates = (): ReadonlyArray<ResourceCandidate> => {
  candidates ??= (Object.keys(RESOURCES) as ReadonlyArray<keyof typeof RESOURCES>).map((name) => {
    const ast = RESOURCES[name].ast;
    let cached: string | undefined;
    return {
      name,
      keys: AST.isObjects(ast) ? sortedKeys(ast.propertySignatures.map((signature) => signature.name)) : "",
      fingerprint: () => {
        if (cached === undefined) {
          const schema: unknown = getJsonSchema(name);
          const root = Predicate.isObject(schema) ? schema : {};
          cached = fingerprint(root, definitionsOf(root));
        }
        return cached;
      },
    };
  });
  return candidates;
};

// Cheap key-set check first; full fingerprints are built only for a candidate with the same keys.
const resourceFor = (node: JsonRecord, definitions: JsonRecord): JsonSchemaName | undefined => {
  const keys = propertyKeys(node);
  if (keys === "") return undefined;
  const matches = resourceCandidates().filter((candidate) => candidate.keys === keys);
  if (matches.length === 0) return undefined;
  const identity = fingerprint(node, definitions);
  return matches.find((candidate) => candidate.fingerprint() === identity)?.name;
};

/** A widening projection: retain first-level shape, never constrain summarized contents. */
export const compactOutputSchema = (schema: Schema.JsonObject): Schema.JsonObject => {
  const definitions = definitionsOf(schema);
  const project = (value: unknown, depth: number, seen: readonly string[] = []): unknown => {
    if (!Predicate.isObject(value)) return value;
    if (typeof value.$ref === "string") {
      const resolved = resolveRef(value, definitions, seen);
      // An unresolved/recursive reference must widen, not leave a dangling ref.
      if (resolved === undefined) return {};
      return project(resolved.node, depth, [...seen, resolved.name]);
    }
    const projected: Record<string, unknown> = {};
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
    if (value.type === "object" || Predicate.isObject(value.properties)) {
      if (depth > 0 && Predicate.isObject(value.properties)) {
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
