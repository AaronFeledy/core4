import { type SchemaAST as AST, Option, ParseResult } from "effect";
import { RecipeServiceMap } from "./recipe-identity.ts";

const recipeServiceMapFilter =
  RecipeServiceMap.ast._tag === "Refinement" ? RecipeServiceMap.ast.filter : undefined;

export const containerKind = (ast: AST.AST): "array" | "object" | undefined => {
  switch (ast._tag) {
    case "Refinement":
    case "Transformation":
      return containerKind(ast.from);
    case "TupleType":
      return "array";
    case "TypeLiteral":
      return "object";
    default:
      return undefined;
  }
};

const containsExpression = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  if ("_tag" in value && value._tag === "AuthoringExpression") return true;
  return Object.values(value).some(containsExpression);
};

const expressionSources = (value: unknown): ReadonlySet<string> => {
  const sources = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (
      "_tag" in candidate &&
      candidate._tag === "AuthoringExpression" &&
      "source" in candidate &&
      typeof candidate.source === "string"
    ) {
      sources.add(candidate.source);
      return;
    }
    for (const nested of Object.values(candidate)) visit(nested);
  };
  visit(value);
  return sources;
};

const projectExpressions = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  if (
    "_tag" in value &&
    value._tag === "AuthoringExpression" &&
    "source" in value &&
    typeof value.source === "string"
  )
    return value.source;
  if (Array.isArray(value)) return value.map(projectExpressions);
  return Object.fromEntries(
    Reflect.ownKeys(value).map((key) => [key, projectExpressions(Reflect.get(value, key))]),
  );
};

const hasRequiredShape = (ast: AST.AST, value: unknown): boolean => {
  switch (ast._tag) {
    case "Refinement":
    case "Transformation":
      return hasRequiredShape(ast.from, value);
    case "TypeLiteral":
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        ast.propertySignatures.every((property) => property.isOptional || property.name in value)
      );
    case "TupleType":
      return (
        Array.isArray(value) &&
        ast.elements.every((element, index) => element.isOptional || index < value.length)
      );
    default:
      return true;
  }
};

const valueAtPath = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
};

export const authoringContainerFilter =
  (refinement: AST.Refinement, partial: boolean): AST.Refinement["filter"] =>
  (input, parseOptions, self) => {
    if (partial && !hasRequiredShape(refinement.from, input)) return Option.none();
    const sources = expressionSources(input);
    if (sources.size === 0) return refinement.filter(input, parseOptions, self);
    if (
      refinement.filter === recipeServiceMapFilter &&
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input)
    ) {
      const literals = Object.fromEntries(
        Object.entries(input).filter(([, value]) => !containsExpression(value)),
      );
      const literalResult = refinement.filter(literals, parseOptions, self);
      if (Option.isSome(literalResult)) return literalResult;
    }
    const result = refinement.filter(projectExpressions(input), parseOptions, self);
    if (Option.isNone(result)) return result;
    const dependsOnExpression = ParseResult.ArrayFormatter.formatIssueSync(result.value).some(
      (issue) =>
        issue.path.length === 0 ||
        containsExpression(valueAtPath(input, issue.path)) ||
        [...sources].some((source) => issue.message.includes(source)),
    );
    return dependsOnExpression ? Option.none() : result;
  };
