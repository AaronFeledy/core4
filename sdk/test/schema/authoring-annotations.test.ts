import { expect, test } from "bun:test";
import * as Public from "@lando/sdk/schema";
import { Predicate, Schema, SchemaAST } from "effect";
import { deprecateSchema, getSchemaDeprecation } from "../../src/schema/deprecation.ts";
import { getJsonSchema } from "../../src/schema/json-schema.ts";
import { withSchemaDeprecations } from "../../src/schema/json-schema-deprecations.ts";
import { getLayerMergeRule } from "../../src/schema/layer-merge.ts";
import { propertyNameRecordProjection } from "../../src/schema/property-name-check.ts";

const authoringSchemas = {
  LandofileAuthoringShape: Public.LandofileAuthoringShape,
  LandofileAuthoringFragment: Public.LandofileAuthoringFragment,
  LandofileAuthoringShapeWire: Public.LandofileAuthoringShapeWire,
  LandofileAuthoringFragmentWire: Public.LandofileAuthoringFragmentWire,
} as const;

const annotation = (path: string, keyword: string, value: unknown): string =>
  `${path || "<root>"} ${keyword} ${JSON.stringify(value)}`;

const visitPath = (visited: WeakMap<object, Set<string>>, node: object, path: string): boolean => {
  const paths = visited.get(node) ?? new Set<string>();
  if (paths.has(path)) return false;
  paths.add(path);
  visited.set(node, paths);
  return true;
};

const declaredAnnotations = (root: SchemaAST.AST, authoredSyntaxOnly: boolean): ReadonlySet<string> => {
  const found = new Set<string>();
  const visited = new WeakMap<object, Set<string>>();
  const walk = (ast: SchemaAST.AST, path: string, ancestors: ReadonlySet<SchemaAST.AST>): void => {
    if (ancestors.has(ast) || !visitPath(visited, ast, path)) return;
    const identifier = SchemaAST.resolveIdentifier(ast);
    if (
      authoredSyntaxOnly &&
      identifier !== undefined &&
      /^(?:SecretRef|BoundText|RouteText|ImportRef)Authoring$/u.test(identifier)
    )
      return;
    const seen = new Set(ancestors).add(ast);
    const merge = getLayerMergeRule(ast);
    if (merge !== undefined) found.add(annotation(path, "x-lando-merge", merge));
    const notice = getSchemaDeprecation(ast);
    if (notice !== undefined) found.add(annotation(path, "x-deprecation", notice));
    if (ast.encoding !== undefined) walk(SchemaAST.toEncoded(ast), path, seen);
    switch (ast._tag) {
      case "Suspend":
        walk(ast.thunk(), path, seen);
        break;
      case "Union":
        for (const member of ast.types) walk(member, path, seen);
        break;
      case "Objects":
        for (const property of ast.propertySignatures) {
          if (typeof property.name !== "string") continue;
          const child = `${path}.${property.name}`;
          const notice = getSchemaDeprecation(property);
          if (notice !== undefined) found.add(annotation(child, "x-deprecation", notice));
          walk(property.type, child, seen);
        }
        for (const signature of ast.indexSignatures) walk(signature.type, `${path}.*`, seen);
        break;
      case "Arrays":
        for (const item of [...ast.elements, ...ast.rest]) walk(item, `${path}[]`, seen);
        break;
      case "Declaration": {
        const projection = propertyNameRecordProjection(ast);
        if (projection !== undefined) walk(projection, path, seen);
        break;
      }
    }
  };
  walk(root, "", new Set());
  return found;
};

const publishedAnnotations = (root: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const visited = new WeakMap<object, Set<string>>();
  const walk = (node: unknown, path: string, ancestors: ReadonlySet<object>): void => {
    if (!Predicate.isObject(node) || ancestors.has(node) || !visitPath(visited, node, path)) return;
    const seen = new Set(ancestors).add(node);
    for (const key of ["x-lando-merge", "x-deprecation"]) {
      if (Object.hasOwn(node, key)) found.add(annotation(path, key, node[key]));
    }
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
      const name = decodeURIComponent(node.$ref.slice(8)).replace(/~1/g, "/").replace(/~0/g, "~");
      if (Predicate.isObject(root) && Predicate.isObject(root.$defs)) walk(root.$defs[name], path, seen);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = node[key];
      if (Array.isArray(branches)) for (const branch of branches) walk(branch, path, seen);
    }
    if (Predicate.isObject(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.${key}`, seen);
    }
    if (Predicate.isObject(node.patternProperties)) {
      for (const child of Object.values(node.patternProperties)) walk(child, `${path}.*`, seen);
    }
    walk(node.additionalProperties, `${path}.*`, seen);
    if (Array.isArray(node.prefixItems)) for (const item of node.prefixItems) walk(item, `${path}[]`, seen);
    walk(node.items, `${path}[]`, seen);
  };
  walk(root, "", new Set());
  return found;
};

for (const name of Object.keys(authoringSchemas) as (keyof typeof authoringSchemas)[]) {
  test(`${name} publishes every declared merge rule and deprecation at its authored path`, () => {
    const expected = declaredAnnotations(authoringSchemas[name].ast, name === "LandofileAuthoringShape");
    const actual = publishedAnnotations(getJsonSchema(name));
    expect([...expected].filter((entry) => !actual.has(entry))).toEqual([]);
  }, 30_000);
}

test("a branch deprecation survives flattening and reordering without marking its siblings", () => {
  const notice = { since: "4.1.0", severity: "warn", note: "Use the replacement spelling." } as const;
  const schema = Schema.Union([
    Schema.Union([deprecateSchema(Schema.String, notice), Schema.Boolean]),
    Schema.Null,
  ]);
  const string = { type: "string" };
  const boolean = { type: "boolean" };
  const nil = { type: "null" };
  const artifact: { readonly anyOf: ReadonlyArray<Record<string, unknown>> } = {
    anyOf: [nil, boolean, string],
  };
  expect(withSchemaDeprecations(schema, artifact)).toEqual({
    anyOf: [nil, boolean, { ...string, deprecated: true, "x-deprecation": notice }],
  });
});
