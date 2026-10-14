import { SchemaAST as AST, Schema } from "effect";
import { LandofileShape, SERVICE_CONFIG_ALIASES } from "../schema/landofile.ts";
import { resolveLayerMergeRule } from "./layer-merge-rules.ts";
import { isLandofileOverride } from "./merge-directives.ts";
import { isPlainRecord } from "./record.ts";

export type DirectivePath = ReadonlyArray<string | number>;

const childAsts = (node: AST.AST, key: string | number): ReadonlyArray<AST.AST> => {
  const ast = AST.toEncoded(node);
  switch (ast._tag) {
    case "Unknown":
    case "Any":
      return [ast];
    case "Union":
      return ast.types.flatMap((member) => childAsts(member, key));
    case "Suspend":
      return childAsts(ast.thunk(), key);
    case "Arrays":
      return typeof key === "number"
        ? [ast.elements[key] ?? ast.rest[0]].filter((value) => value !== undefined)
        : [];
    case "Objects":
      return [
        ...ast.propertySignatures
          .filter((property) => property.name === key)
          .map((property) => property.type),
        ...ast.indexSignatures
          .filter((index) => Schema.is(Schema.make(index.parameter))(key))
          .map((index) => index.type),
      ];
    default:
      return [];
  }
};

export const isAuthoredKey = (path: DirectivePath): boolean => {
  let nodes: ReadonlyArray<AST.AST> = [LandofileShape.ast];
  for (const segment of path) nodes = nodes.flatMap((node) => childAsts(node, segment));
  return nodes.length > 0;
};

export const canonicalDirectivePath = (path: DirectivePath): DirectivePath =>
  path.map((segment, index) =>
    index === 2 && path[0] === "services" && typeof segment === "string"
      ? (SERVICE_CONFIG_ALIASES.find(([alias]) => alias === segment)?.[1] ?? segment)
      : segment,
  );

export const directivePathProblem = (input: unknown, path: DirectivePath): string | undefined => {
  if (!isAuthoredKey(path)) return "Unknown authored target key.";
  let current = input;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (segment === undefined) return "Missing directive path.";
    const prefix = canonicalDirectivePath(path.slice(0, index));
    if (typeof segment === "number") {
      const rule = resolveLayerMergeRule(LandofileShape, prefix).descriptor;
      if (!Array.isArray(current) || rule.kind !== "keyed")
        return "Directive crosses a non-index-preserving decode branch.";
      current = current[segment];
    } else {
      if (!isPlainRecord(current)) return "Directive crosses a reshaped value.";
      if (index > 0 && typeof path[index - 1] === "number") {
        const rule = resolveLayerMergeRule(
          LandofileShape,
          canonicalDirectivePath(path.slice(0, index - 1)),
        ).descriptor;
        if (rule.kind === "keyed") {
          const identityFields = {
            "route-match": ["hostname", "scheme", "pathPrefix"],
            "dependency-service": ["service"],
            "filter-name-or-type": ["name", "type"],
            "endpoint-name": ["name"],
            "port-name": ["name"],
            "log-id": ["id", "path"],
          };
          if (identityFields[rule.identity].includes(segment))
            return "Cannot change a keyed-list identity field; override the containing collection.";
        }
      }
      if (prefix.at(-1) === "dependsOn" && !Array.isArray(current))
        return "Directive crosses the dependency-map decode boundary.";
      if (
        prefix.at(-1) === "security" &&
        ["cas", "certificate-authority", "certificate-authorities"].includes(segment)
      )
        return "Directives on security CA aliases are unsupported; override security using canonical ca.";
      current = current[segment];
      if (isLandofileOverride(current)) current = current.value;
    }
  }
  return undefined;
};
