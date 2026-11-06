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
      if (!(key in merged) || JSON.stringify(merged[key]) === JSON.stringify(value)) merged[key] = value;
      else conflicts.push({ [key]: value });
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
