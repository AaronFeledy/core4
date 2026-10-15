import type { SchemaAST as AST, Schema } from "effect";
import { type LayerMergeRule, getLayerMergeRule } from "../schema/layer-merge.ts";

type MergeNode = {
  rule?: LayerMergeRule;
  readonly properties: Map<string, MergeNode>;
  record?: MergeNode;
  item?: MergeNode;
};
const node = (): MergeNode => ({ properties: new Map() });
const cache = new WeakMap<AST.AST, MergeNode>();
const replace = { kind: "replace" } as const;

class LayerMergeDeclarationError extends Error {
  constructor(
    readonly path: ReadonlyArray<string>,
    readonly reason: string,
  ) {
    super(`Layer merge declaration at ${path.join(".") || "<root>"}: ${reason}`);
    this.name = "LayerMergeDeclarationError";
  }
}

const admitsObject = (ast: AST.AST, seen = new Set<AST.AST>()): boolean => {
  if (seen.has(ast)) return false;
  seen.add(ast);
  if (ast.encoding?.some((link) => admitsObject(link.to, seen))) return true;
  switch (ast._tag) {
    case "Objects":
    case "ObjectKeyword":
    case "Unknown":
    case "Any":
    case "Declaration":
      return true;
    case "Union":
      return ast.types.some((type) => admitsObject(type, seen));
    case "Suspend":
      return admitsObject(ast.thunk(), seen);
    case "Arrays":
      return [...ast.elements, ...ast.rest].some((type) => admitsObject(type, seen));
    default:
      return false;
  }
};

const declare = (target: MergeNode, rule: LayerMergeRule, path: ReadonlyArray<string>) => {
  const previous = target.rule;
  if (
    previous !== undefined &&
    (previous.kind !== rule.kind ||
      (previous.kind === "keyed" &&
        rule.kind === "keyed" &&
        (previous.identity !== rule.identity ||
          previous.onMatch !== rule.onMatch ||
          previous.whenUnkeyed !== rule.whenUnkeyed)))
  ) {
    throw new LayerMergeDeclarationError(path, "conflicting collection policies");
  }
  target.rule = rule;
};

const compile = (root: AST.AST): MergeNode => {
  const cached = cache.get(root);
  if (cached !== undefined) return cached;
  const result = node();
  const missing = new Set<string>();
  const visited = new WeakMap<MergeNode, Set<AST.AST>>();
  const walk = (
    ast: AST.AST,
    target: MergeNode,
    context: {
      readonly path: ReadonlyArray<string>;
      readonly inherited?: LayerMergeRule;
      readonly ancestors: ReadonlyMap<AST.AST, MergeNode>;
    },
  ): void => {
    let seen = visited.get(target);
    if (seen === undefined) {
      seen = new Set();
      visited.set(target, seen);
    }
    if (seen.has(ast)) return;
    seen.add(ast);
    const rule = getLayerMergeRule(ast) ?? context.inherited;
    if (rule !== undefined) declare(target, rule, context.path);
    const ancestors = new Map(context.ancestors).set(ast, target);
    const atSamePath = (child: AST.AST) =>
      walk(child, target, {
        ...context,
        ancestors,
        ...(rule === undefined ? {} : { inherited: rule }),
      });
    for (const link of ast.encoding ?? []) atSamePath(link.to);
    if (ast._tag === "Unknown" || ast._tag === "Any") return;
    const childNode = (child: AST.AST, current: MergeNode | undefined): MergeNode =>
      ancestors.get(child) ?? current ?? node();
    const atChild = (child: AST.AST, next: MergeNode, segment: string) =>
      walk(child, next, { path: [...context.path, segment], ancestors });
    switch (ast._tag) {
      case "Union":
        for (const member of ast.types) atSamePath(member);
        break;
      case "Suspend":
        atSamePath(ast.thunk());
        break;
      case "Objects":
        for (const property of ast.propertySignatures) {
          if (typeof property.name !== "string") continue;
          const next = childNode(property.type, target.properties.get(property.name));
          target.properties.set(property.name, next);
          atChild(property.type, next, property.name);
        }
        for (const index of ast.indexSignatures) {
          target.record = childNode(index.type, target.record);
          atChild(index.type, target.record, "*");
        }
        break;
      case "Arrays": {
        const elements = [...ast.elements, ...ast.rest];
        if (rule === undefined && elements.some((element) => admitsObject(element))) {
          missing.add(context.path.join("."));
        }
        declare(target, rule ?? replace, context.path);
        for (const element of elements) {
          target.item = childNode(element, target.item);
          atChild(element, target.item, "[]");
        }
        break;
      }
      default:
        break;
    }
  };
  walk(root, result, { path: [], ancestors: new Map() });
  if (missing.size > 0)
    throw new LayerMergeDeclarationError(
      [],
      `object-admitting arrays have no policy: ${[...missing].join(", ")}`,
    );
  cache.set(root, result);
  return result;
};

/** Verify that every modeled object-admitting array has an unambiguous policy. */
export const assertLayerMergeCompleteness = (root: Schema.Top): void => {
  compile(root.ast);
};

/** Read the compiled schema policy at a concrete property or array-item path. */
export const layerMergeRuleAt = (root: Schema.Top, path: ReadonlyArray<string | number>): LayerMergeRule => {
  let current: MergeNode | undefined = compile(root.ast);
  for (const segment of path) {
    current =
      typeof segment === "number" ? current?.item : (current?.properties.get(segment) ?? current?.record);
  }
  return current?.rule ?? replace;
};

/** List recursive collection paths for generated schema references. */
export const listLayerMergeRules = (
  root: Schema.Top,
): ReadonlyArray<{
  readonly path: string;
  readonly rule: LayerMergeRule;
}> => {
  const entries: { path: string; rule: LayerMergeRule }[] = [];
  const walk = (current: MergeNode, path: string, ancestors: ReadonlySet<MergeNode>): void => {
    if (ancestors.has(current)) return;
    if (current.rule !== undefined) entries.push({ path: path || "<root>", rule: current.rule });
    const seen = new Set(ancestors).add(current);
    for (const [key, child] of current.properties) walk(child, path ? `${path}.${key}` : key, seen);
    if (current.record !== undefined) walk(current.record, path ? `${path}.*` : "*", seen);
    if (current.item !== undefined) walk(current.item, `${path}[]`, seen);
  };
  walk(compile(root.ast), "", new Set());
  return entries;
};
