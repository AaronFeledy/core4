import { Predicate } from "effect";
import { JSON_SCHEMA_FIELD_PROVENANCE_KEY } from "./json-schema-field-provenance.ts";

const genericDescription =
  /^(?:a (?:string|number|boolean|bigint|symbol|finite number)|an (?:integer|object|array)|null|unknown)$|^(?:a (?:value|number|string|finite number)|an integer) (?:with |between |greater |less |matching |of )/u;
export const isUsefulFieldDescription = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !genericDescription.test(value.trim());

const annotationKeys = new Set(["title", "description", "default", "examples", "deprecated", "$comment"]);
const unionKeys = ["anyOf", "oneOf"] as const;

const record = (value: unknown) => (Predicate.isObject(value) && !Array.isArray(value) ? value : undefined);

const ignored = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === false) return true;
  const node = record(value);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  const negated = record(node.not);
  if (negated && Object.keys(negated).length === 0) return true;
  if (record(node[JSON_SCHEMA_FIELD_PROVENANCE_KEY])?.role === "expression-arm") return true;
  // Effect can move the expression pattern and its provenance into a filter wrapper.
  if (Array.isArray(node.allOf) && node.allOf.some((member) => ignored(member, seen))) return true;
  return unionKeys.some(
    (key) =>
      Array.isArray(node[key]) &&
      node[key].length > 0 &&
      node[key].every((member: unknown) => ignored(member, new Set(seen))),
  );
};

const pointer = (key: string) => encodeURIComponent(key.replaceAll("~", "~0").replaceAll("/", "~1"));

const resolve = (root: unknown, ref: string): unknown => {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  return decodeURIComponent(ref.slice(2))
    .split("/")
    .reduce<unknown>((node, key) => {
      const name = key.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!Predicate.isObject(node) || !Object.hasOwn(node, name)) return undefined;
      return node[name];
    }, root);
};

const described = (root: unknown, value: unknown, seen = new Set<object>()): boolean => {
  if (ignored(value)) return true;
  const node = record(value);
  if (!node || seen.has(node)) return false;
  const next = new Set(seen).add(node);
  if (isUsefulFieldDescription(node.description)) return true;
  if (typeof node.$ref === "string" && described(root, resolve(root, node.$ref), next)) return true;
  if (
    Array.isArray(node.allOf) &&
    node.allOf.some((entry: unknown) => {
      const member = record(entry);
      return (
        member &&
        !ignored(member) &&
        (typeof member.$ref === "string" || Object.keys(member).every((key) => annotationKeys.has(key))) &&
        described(root, member, next)
      );
    })
  )
    return true;
  return unionKeys.some(
    (key) =>
      Array.isArray(node[key]) &&
      node[key].length > 0 &&
      node[key].every((member: unknown) => described(root, member, next)),
  );
};

export const collectMissingFieldDescriptions = (document: unknown, artifact: string): readonly string[] => {
  const missing = new Set<string>();
  const visitedRefs = new Set(["#"]);
  const visit = (value: unknown, path: string): void => {
    const node = record(value);
    if (!node || ignored(node)) return;
    if (typeof node.$ref === "string" && !visitedRefs.has(node.$ref)) {
      visitedRefs.add(node.$ref);
      visit(resolve(document, node.$ref), node.$ref.slice(1));
    }
    for (const [key, field] of Object.entries(record(node.properties) ?? {})) {
      if (ignored(field)) continue;
      const child = `${path}/${pointer(key)}`;
      if (!described(document, field)) missing.add(`${artifact}#${child}`);
      visit(field, child);
    }
    for (const key of [...unionKeys, "allOf", "items", "prefixItems"] as const) {
      const children = node[key];
      if (Array.isArray(children))
        children.forEach((child: unknown, index) => {
          visit(child, `${path}/${key}/${index}`);
        });
      else visit(children, `${path}/${key}`);
    }
    for (const key of ["additionalProperties", "additionalItems"] as const)
      visit(node[key], `${path}/${key}`);
    for (const [pattern, child] of Object.entries(record(node.patternProperties) ?? {})) {
      visit(child, `${path}/patternProperties/${pointer(pattern)}`);
    }
  };
  visit(document, "");
  return [...missing].sort();
};

export const assertEmittedFieldDescriptions = (
  artifacts: ReadonlyMap<string, unknown>,
  debt: ReadonlySet<string>,
): void => {
  const actual = new Set(
    [...artifacts].flatMap(([name, document]) => collectMissingFieldDescriptions(document, name)),
  );
  const added = [...actual].filter((path) => !debt.has(path)).map((path) => `+ ${path}`);
  const repaired = [...debt].filter((path) => !actual.has(path)).map((path) => `- ${path}`);
  if (added.length || repaired.length) {
    throw new Error(
      `Emitted field-description gate failed (+ undocumented, - remove shrink-only debt):\n${[...added, ...repaired].join("\n")}`,
    );
  }
};
