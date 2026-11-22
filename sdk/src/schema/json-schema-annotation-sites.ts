import * as AST from "effect/SchemaAST";
import { getSchemaDeprecation } from "./deprecation.ts";
import { getLayerMergeRule } from "./layer-merge.ts";
import { propertyNameRecordProjection } from "./property-name-check.ts";

// ==== AST nodes that can contribute edits to a published JSON Schema

const annotationChildren = (ast: AST.AST): readonly AST.AST[] => {
  if (AST.isSuspend(ast)) return [ast.thunk()];
  // Union traversal can inspect both the declared and encoded alternatives.
  if (AST.isUnion(ast)) return ast.encoding === undefined ? ast.types : [...ast.types, AST.toEncoded(ast)];
  if (ast.encoding !== undefined) return [AST.toEncoded(ast)];
  if (AST.isArrays(ast)) return [...ast.elements, ...ast.rest];
  if (AST.isObjects(ast))
    return [
      ...ast.propertySignatures.map(({ type }) => type),
      ...ast.indexSignatures.map(({ type }) => type),
    ];
  if (AST.isDeclaration(ast)) {
    const projection = propertyNameRecordProjection(ast);
    if (projection !== undefined) return [projection];
  }
  return [];
};

export const jsonSchemaAnnotationSites = (root: AST.AST): WeakSet<AST.AST> => {
  const parents = new WeakMap<AST.AST, AST.AST[]>([[root, []]]);
  const pending = [root];
  const annotated: AST.AST[] = [];
  for (const ast of pending) {
    if (
      ast.annotations?.jsonSchemaProjection !== undefined ||
      getSchemaDeprecation(ast) !== undefined ||
      getLayerMergeRule(ast) !== undefined ||
      (AST.isObjects(ast) &&
        ast.propertySignatures.some((property) => getSchemaDeprecation(property) !== undefined))
    )
      annotated.push(ast);
    for (const child of annotationChildren(ast)) {
      const existing = parents.get(child);
      if (existing === undefined) {
        parents.set(child, [ast]);
        pending.push(child);
      } else existing.push(ast);
    }
  }

  // Walk backwards from the edits: a recursive back edge is not evidence that
  // a subtree has no annotations. Propagation marks every path to an edit.
  const sites = new WeakSet(annotated);
  for (const ast of annotated) {
    for (const parent of parents.get(ast) ?? []) {
      if (sites.has(parent)) continue;
      sites.add(parent);
      annotated.push(parent);
    }
  }
  return sites;
};
