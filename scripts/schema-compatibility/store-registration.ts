import { relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { Glob } from "bun";

import { ALL_PACKAGE_SOURCE_ROOTS } from "../boundary/workspace-roots.ts";
import type { LifecycleDeclaration, StoreLifecycle } from "./internal-stores.ts";
import { type JsonValue, isJsonObject } from "./model.ts";

/** A durable `StateStore.open` / `PluginStateStore.open` bucket spec written in shipped source. */
export interface DurableBucketSite {
  readonly file: string;
  readonly line: number;
  readonly schema: string;
}

const specProperties = (node: ts.ObjectLiteralExpression): ReadonlyMap<string, ts.ObjectLiteralElementLike> =>
  new Map(
    node.properties.flatMap((property) =>
      property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? [[property.name.text, property] as const]
        : [],
    ),
  );

const initializerText = (property: ts.ObjectLiteralElementLike, source: ts.SourceFile): string =>
  (ts.isPropertyAssignment(property) ? property.initializer : property).getText(source).replace(/\s+/gu, "");

/** Cache buckets declare `root: "userCache"`; every other root, and a plugin bucket's absent root, is durable. */
const isCacheRoot = (property: ts.ObjectLiteralElementLike | undefined): boolean =>
  property !== undefined &&
  ts.isPropertyAssignment(property) &&
  ts.isStringLiteralLike(property.initializer) &&
  property.initializer.text === "userCache";

/**
 * Every object literal shaped like a bucket spec (`key`, `schema`, and `version`),
 * wherever it is written: inline in `.open(...)`, in a spec constant, or returned
 * by a spec factory.
 */
export const findDurableBucketSites = async (repoRoot: string): Promise<ReadonlyArray<DurableBucketSite>> => {
  const sites: DurableBucketSite[] = [];
  const roots = ALL_PACKAGE_SOURCE_ROOTS.filter((root) => root !== "docs/src");
  for (const root of roots) {
    for await (const path of new Glob(`${root}/**/*.{ts,tsx}`).scan({ cwd: repoRoot })) {
      // Contract-suite harnesses under src/test open fixture buckets in test-owned roots.
      if (path.endsWith(".d.ts") || path.includes("/src/test/")) continue;
      const file = relative(repoRoot, resolve(repoRoot, path)).replaceAll("\\", "/");
      const source = ts.createSourceFile(
        file,
        await Bun.file(resolve(repoRoot, path)).text(),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const properties = specProperties(node);
          const schema = properties.get("schema");
          if (
            schema !== undefined &&
            properties.has("key") &&
            properties.has("version") &&
            !isCacheRoot(properties.get("root"))
          ) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            sites.push({ file, line: line + 1, schema: initializerText(schema, source) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};

/**
 * Every enum-valued field of a JSON Schema document, keyed by path (`.` between
 * properties, `[]` for array items and record values). A tagged union of objects
 * counts as an enum of its `_tag` values.
 */
export const enumFields = (document: unknown): ReadonlyMap<string, ReadonlySet<string>> => {
  const defs = isJsonObject(document) && isJsonObject(document.$defs) ? document.$defs : {};
  const resolveRef = (node: unknown): { readonly node: unknown; readonly ref?: string } => {
    if (!isJsonObject(node) || typeof node.$ref !== "string") return { node };
    const ref = decodeURIComponent(node.$ref.replace(/^#\/\$defs\//u, ""));
    return { node: defs[ref] ?? null, ref };
  };
  const members = (node: unknown): ReadonlyArray<JsonValue> =>
    isJsonObject(node)
      ? (["anyOf", "oneOf", "allOf"] as const).flatMap((key) => {
          const value = node[key];
          return Array.isArray(value) ? value : [];
        })
      : [];
  const values = (raw: unknown): ReadonlyArray<string> => {
    const { node } = resolveRef(raw);
    if (!isJsonObject(node)) return [];
    const own = [
      ...(Array.isArray(node.enum) ? node.enum : []),
      ...(node.const === undefined ? [] : [node.const]),
    ].filter((value) => typeof value === "string");
    const tag = isJsonObject(node.properties) ? node.properties._tag : undefined;
    return [...own, ...(tag === undefined ? [] : values(tag)), ...members(node).flatMap(values)];
  };

  const fields = new Map<string, Set<string>>();
  const walk = (raw: unknown, path: string, refs: ReadonlySet<string>): void => {
    const { node, ref } = resolveRef(raw);
    if (!isJsonObject(node) || (ref !== undefined && refs.has(ref))) return;
    const inside = ref === undefined ? refs : new Set([...refs, ref]);
    for (const [name, child] of Object.entries(isJsonObject(node.properties) ? node.properties : {})) {
      const childPath = path === "" ? name : `${path}.${name}`;
      const found = values(child);
      if (found.length > 0) fields.set(childPath, new Set([...(fields.get(childPath) ?? []), ...found]));
      walk(child, childPath, inside);
    }
    for (const member of members(node)) walk(member, path, inside);
    const collections = [
      node.items,
      node.additionalProperties,
      ...Object.values(isJsonObject(node.patternProperties) ? node.patternProperties : {}),
    ];
    for (const element of collections) if (isJsonObject(element)) walk(element, `${path}[]`, inside);
  };
  walk(document, "", new Set());
  return fields;
};

const LIFECYCLE_FIELD_NAMES = new Set(["status", "phase", "state"]);

const declaredStates = (declaration: Exclude<LifecycleDeclaration, string>): ReadonlySet<string> =>
  "edges" in declaration
    ? new Set(
        Object.values(declaration.edges).flatMap((edge) => [
          ...edge.from,
          ...(edge.to === undefined ? [] : [edge.to]),
          ...(edge.settledIn ?? []),
        ]),
      )
    : new Set(Object.values(declaration.obligations).flatMap((edge) => [...edge.adds, ...edge.clears]));

const uncoveredValues = (
  path: string,
  values: ReadonlySet<string>,
  declaration: LifecycleDeclaration,
): ReadonlyArray<string> => {
  switch (declaration) {
    case "observed":
    case "none":
      return [];
    default: {
      const states = declaredStates(declaration);
      const missing = [...values].filter((value) => !states.has(value));
      return missing.length === 0
        ? []
        : [`${path} stores ${missing.join(", ")}, which its lifecycle table never names.`];
    }
  }
};

/** Lifecycle-declaration problems for one registered store, given its enum fields. */
export const lifecycleProblems = (
  lifecycle: StoreLifecycle,
  fields: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<string> => {
  if (typeof lifecycle === "object" && "presence" in lifecycle)
    return uncoveredValues("record presence", new Set(["absent", "present"]), lifecycle.presence);
  const lifecycleFields = [...fields].filter(([path]) =>
    LIFECYCLE_FIELD_NAMES.has(path.split(".").at(-1) ?? ""),
  );
  if (typeof lifecycle === "object" && "fields" in lifecycle) {
    // A field declared "none" here is an explicit statement that it is plain data.
    const declared = new Map(Object.entries(lifecycle.fields));
    return [
      ...lifecycleFields
        .filter(([path]) => !declared.has(path))
        .map(([path]) => `${path} is a lifecycle enum missing from the lifecycle field map.`),
      ...[...declared].flatMap(([path, declaration]) => {
        const values = fields.get(path);
        return values === undefined
          ? [`lifecycle field ${path} is not an enum field of the schema.`]
          : uncoveredValues(path, values, declaration);
      }),
    ];
  }
  if (lifecycle === "none")
    return lifecycleFields.map(
      ([path, values]) =>
        `${path} is a lifecycle enum (${[...values].join(", ")}) but the store declares lifecycle "none"; declare its transitions table, "observed", or a field map.`,
    );
  if (typeof lifecycle === "object" && lifecycleFields.length === 0)
    return [
      "declares a lifecycle table but has no status, phase, or state enum; map the field path under `fields`.",
    ];
  return lifecycleFields.flatMap(([path, values]) => uncoveredValues(path, values, lifecycle));
};
