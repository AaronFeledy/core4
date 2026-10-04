import { SchemaAST as AST, SchemaIssue } from "effect";
import { RecipeServiceMap } from "./recipe-identity.ts";

const recipeServiceMapFilter = RecipeServiceMap.ast.checks?.[0];

export const containerKind = (ast: AST.AST): "array" | "object" | undefined => {
  switch (ast._tag) {
    case "Arrays":
      return "array";
    case "Objects":
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
    case "Objects":
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        ast.propertySignatures.every((property) => AST.isOptional(property.type) || property.name in value)
      );
    case "Arrays":
      return (
        Array.isArray(value) &&
        ast.elements.every((element, index) => AST.isOptional(element) || index < value.length)
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

export const authoringContainerFilter = (refinement: AST.AST, partial: boolean): AST.Filter<unknown> => {
  const run = (
    check: AST.Check<unknown>,
    input: unknown,
    self: AST.AST,
    parseOptions: AST.ParseOptions,
  ): SchemaIssue.Issue | undefined => {
    if (check._tag === "Filter") {
      const issue = check.run(input, self, parseOptions);
      return issue === undefined ? undefined : new SchemaIssue.Filter(check, issue, input, parseOptions);
    }
    for (const nested of check.checks) {
      const issue = run(nested, input, self, parseOptions);
      if (issue !== undefined) return issue;
    }
    return undefined;
  };
  return new AST.Filter((input, self, parseOptions) => {
    if (partial && !hasRequiredShape(refinement, input)) return undefined;
    const sources = expressionSources(input);
    for (const check of refinement.checks ?? []) {
      if (sources.size === 0) {
        const result = run(check, input, self, parseOptions);
        if (result !== undefined) return result;
        continue;
      }
      if (
        check._tag === "Filter" &&
        recipeServiceMapFilter?._tag === "Filter" &&
        check.run === recipeServiceMapFilter.run &&
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input)
      ) {
        const literals = Object.fromEntries(
          Object.entries(input).filter(([, value]) => !containsExpression(value)),
        );
        const literalResult = run(check, literals, self, parseOptions);
        if (literalResult !== undefined) return literalResult;
      }
      const result = run(check, projectExpressions(input), self, parseOptions);
      if (result === undefined) continue;
      const dependsOnExpression = SchemaIssue.makeFormatterStandardSchemaV1()(result).issues.some(
        (issue) =>
          (issue.path ?? []).length === 0 ||
          containsExpression(
            valueAtPath(
              input,
              (issue.path ?? []).map((key) => (typeof key === "object" ? key.key : key)),
            ),
          ) ||
          [...sources].some((source) => issue.message.includes(source)),
      );
      if (!dependsOnExpression) return result;
    }
    return undefined;
  });
};
