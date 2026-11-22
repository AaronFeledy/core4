import { type JsonSchema, Predicate } from "effect";

export type SchemaNode = boolean | JsonSchema.JsonSchema;
export const schemaNode = (value: unknown): SchemaNode | undefined =>
  typeof value === "boolean" || Predicate.isObject(value) ? value : undefined;

export const localReference = (
  document: JsonSchema.JsonSchema,
  reference: string,
): SchemaNode | undefined => {
  if (!reference.startsWith("#")) return undefined;
  const pointer = decodeURIComponent(reference.slice(1));
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let value: unknown = document;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    value = Predicate.isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  return schemaNode(value);
};

/** Expand conjunctions only; unions retain their branch boundaries. */
export const conjuncts = (document: JsonSchema.JsonSchema, node: SchemaNode): readonly SchemaNode[] => {
  const expand = (current: SchemaNode, seen: ReadonlySet<string>): readonly SchemaNode[] => {
    if (typeof current === "boolean") return [current];
    const { $ref, allOf, $defs: _definitions, $schema: _dialect, ...own } = current;
    const parts: SchemaNode[] = Object.keys(own).length === 0 ? [] : [own];
    if (typeof $ref === "string" && !seen.has($ref)) {
      const target = localReference(document, $ref);
      if (target !== undefined) parts.push(...expand(target, new Set([...seen, $ref])));
    }
    if (Array.isArray(allOf)) {
      for (const member of allOf) {
        const child = schemaNode(member);
        if (child !== undefined) parts.push(...expand(child, seen));
      }
    }
    return parts;
  };
  return expand(node, new Set());
};

/** Annotations describe a node; differing text in two conjuncts is not a schema conflict. */
const ANNOTATION_KEYWORDS = new Set(["description", "title", "examples"]);

/**
 * The most specific description. Effect keeps a base type's description on the node and appends
 * each later annotation as an `allOf` member, so the last member with a description is the field's.
 */
export const primaryDescription = (
  document: JsonSchema.JsonSchema,
  node: SchemaNode,
  seen: ReadonlySet<string> = new Set(),
): string | undefined => {
  if (typeof node === "boolean") return undefined;
  if (Array.isArray(node.allOf))
    for (const member of [...node.allOf].reverse()) {
      const child = schemaNode(member);
      if (typeof child === "object" && typeof child.description === "string") return child.description;
    }
  if (typeof node.description === "string") return node.description;
  if (typeof node.$ref === "string" && !seen.has(node.$ref)) {
    const target = localReference(document, node.$ref);
    if (target !== undefined) return primaryDescription(document, target, new Set([...seen, node.$ref]));
  }
  // A key reached through a union is described when every arm that describes it agrees.
  const arms = node.anyOf ?? node.oneOf;
  if (!Array.isArray(arms)) return undefined;
  const described = new Set(
    arms.flatMap((arm) => {
      const child = schemaNode(arm);
      const found = child === undefined ? undefined : primaryDescription(document, child, seen);
      return found === undefined ? [] : [found];
    }),
  );
  return described.size === 1 ? [...described][0] : undefined;
};

export const conjoin = (nodes: readonly SchemaNode[]): SchemaNode => {
  if (nodes.length === 1) return nodes[0] ?? true;
  const merged: JsonSchema.JsonSchema = {};
  const conflicts: SchemaNode[] = [];
  for (const node of nodes) {
    if (node === true) continue;
    if (node === false) {
      conflicts.push(false);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      const current = merged[key];
      if (typeof current === "number" && typeof value === "number" && key === "minimum")
        merged[key] = Math.max(current, value);
      else if (typeof current === "number" && typeof value === "number" && key === "maximum")
        merged[key] = Math.min(current, value);
      else if (!(key in merged) || JSON.stringify(current) === JSON.stringify(value)) merged[key] = value;
      else if (!ANNOTATION_KEYWORDS.has(key)) conflicts.push({ [key]: value });
    }
  }
  return conflicts.length === 0 ? merged : { allOf: [merged, ...conflicts] };
};

export const forbidden = (node: SchemaNode): boolean =>
  node === false ||
  (typeof node === "object" && Predicate.isObject(node.not) && Object.keys(node.not).length === 0);

export const fixedKeys = (document: JsonSchema.JsonSchema, node: SchemaNode): readonly string[] => {
  const keys = new Set<string>();
  const seen = new Set<SchemaNode>();
  const visit = (node: SchemaNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const part of conjuncts(document, node)) {
      if (typeof part === "boolean") continue;
      if (Predicate.isObject(part.properties)) {
        for (const key of Object.keys(part.properties)) keys.add(key);
      }
      for (const keyword of ["anyOf", "oneOf"]) {
        const branches = part[keyword];
        if (!Array.isArray(branches)) continue;
        for (const branch of branches) {
          const child = schemaNode(branch);
          if (child !== undefined) visit(child);
        }
      }
    }
  };
  visit(node);
  return [...keys].sort();
};

export const schemaChild = (
  document: JsonSchema.JsonSchema,
  node: SchemaNode,
  segment: string | number,
): SchemaNode | undefined => {
  const active = new Set<SchemaNode>();
  const visit = (node: SchemaNode): SchemaNode | undefined => {
    if (active.has(node)) return undefined;
    active.add(node);
    const child = resolve(node);
    active.delete(node);
    return child;
  };
  const resolve = (node: SchemaNode): SchemaNode | undefined => {
    const children: SchemaNode[] = [];
    let constrained = false;
    for (const part of conjuncts(document, node)) {
      if (part === true) continue;
      if (forbidden(part)) {
        children.push(part);
        continue;
      }
      if (typeof part === "boolean") continue;
      if (
        [
          "type",
          "properties",
          "patternProperties",
          "additionalProperties",
          "items",
          "prefixItems",
          "const",
          "enum",
          "anyOf",
          "oneOf",
        ].some((key) => key in part)
      )
        constrained = true;
      for (const keyword of ["anyOf", "oneOf"]) {
        const branches = part[keyword];
        if (!Array.isArray(branches)) continue;
        const resolved = branches.flatMap((branch) => {
          const member = schemaNode(branch);
          const child = member === undefined ? undefined : visit(member);
          return child === undefined ? [] : [child];
        });
        if (resolved.length > 0) children.push({ [keyword]: resolved });
      }
      if (typeof segment === "number") {
        const tuple = Array.isArray(part.prefixItems) ? part.prefixItems : [];
        const child = schemaNode(segment < tuple.length ? tuple[segment] : part.items);
        if (child !== undefined) children.push(child);
        continue;
      }
      const matches: SchemaNode[] = [];
      if (Predicate.isObject(part.properties) && Object.hasOwn(part.properties, segment)) {
        const property = schemaNode(part.properties[segment]);
        if (property !== undefined) matches.push(property);
      }
      if (Predicate.isObject(part.patternProperties)) {
        for (const [pattern, value] of Object.entries(part.patternProperties)) {
          const property = schemaNode(value);
          if (property !== undefined && new RegExp(pattern).test(segment)) matches.push(property);
        }
      }
      if (matches.length > 0) children.push(...matches);
      else {
        const additional = schemaNode(part.additionalProperties);
        // Closed mappings report an unknown path, rather than inventing a named anti-field.
        if (additional !== undefined && additional !== false) children.push(additional);
      }
    }
    if (children.length > 0) return conjoin(children);
    return constrained ? undefined : true;
  };
  return visit(node);
};
