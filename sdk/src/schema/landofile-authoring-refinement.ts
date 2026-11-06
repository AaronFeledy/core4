import { SchemaAST as AST, Result, Schema, SchemaIssue } from "effect";
import { isLandofileOverride, isLandofileReset } from "../landofile/merge-directives.ts";
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

const isExpression = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "AuthoringExpression";

const containsExpression = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  if (isExpression(value)) return true;
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

const projectCheckInput = (value: unknown): unknown => {
  if (isLandofileReset(value)) return undefined;
  if (isLandofileOverride(value)) return projectCheckInput(value.value);
  if (typeof value !== "object" || value === null) return value;
  if (
    "_tag" in value &&
    value._tag === "AuthoringExpression" &&
    "source" in value &&
    typeof value.source === "string"
  )
    return value.source;
  if (Array.isArray(value)) return value.map(projectCheckInput);
  return Object.fromEntries(
    Reflect.ownKeys(value)
      .filter((key) => !isLandofileReset(Reflect.get(value, key)))
      .map((key) => [key, projectCheckInput(Reflect.get(value, key))]),
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

const expressionAtOrAbovePath = (value: unknown, path: ReadonlyArray<PropertyKey>): boolean => {
  let current = value;
  for (const key of path) {
    while (isLandofileOverride(current)) current = current.value;
    if (isExpression(current)) return true;
    if (isLandofileReset(current)) return true;
    if (typeof current !== "object" || current === null) return false;
    current = Reflect.get(current, key);
  }
  while (isLandofileOverride(current)) current = current.value;
  if (isLandofileReset(current)) return true;
  return containsExpression(current);
};

const onlyMissingKeys = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "MissingKey":
      return true;
    case "Pointer":
    case "Encoding":
    case "Filter":
      return onlyMissingKeys(issue.issue);
    case "Composite":
      return issue.issues.length > 0 && issue.issues.every(onlyMissingKeys);
    case "AnyOf":
      return issue.issues.some(onlyMissingKeys);
    default:
      return false;
  }
};

const leafChecks = (check: AST.Check<unknown>): ReadonlyArray<AST.Filter<unknown>> =>
  check._tag === "FilterGroup" ? check.checks.flatMap(leafChecks) : [check];

export const authoringContainerFilter = (
  refinement: AST.Objects | AST.Arrays,
  partial: boolean,
): AST.Filter<unknown> => {
  const encoded = AST.toEncoded(refinement);
  const encodedChecks = new Set((encoded.checks ?? []).flatMap(leafChecks));
  const withoutOwnChecks =
    refinement._tag === "Objects"
      ? new AST.Objects(
          refinement.propertySignatures,
          refinement.indexSignatures,
          refinement.annotations,
          undefined,
          refinement.encoding,
          refinement.context,
          refinement.encodingChecks,
        )
      : new AST.Arrays(
          refinement.isMutable,
          refinement.elements,
          refinement.rest,
          refinement.annotations,
          undefined,
          refinement.encoding,
          refinement.context,
          refinement.encodingChecks,
        );
  const decodeWithoutOwnChecks = Schema.decodeUnknownResult(
    Schema.make<Schema.Codec<unknown>>(withoutOwnChecks),
  );
  const run = (
    check: AST.Filter<unknown>,
    input: unknown,
    self: AST.AST,
    parseOptions: AST.ParseOptions,
  ): SchemaIssue.Issue | undefined => {
    const issue = check.run(input, self, parseOptions);
    return issue === undefined ? undefined : new SchemaIssue.Filter(check, issue, input, parseOptions);
  };
  return new AST.Filter((input, self, parseOptions) => {
    if (partial && !hasRequiredShape(encoded, input)) return undefined;
    const sources = expressionSources(input);
    let normalized: ReturnType<typeof decodeWithoutOwnChecks> | undefined;
    for (const check of (refinement.checks ?? []).flatMap(leafChecks)) {
      // Checks removed by toEncoded expect a normalized Type value, including child defaults.
      // The authoring result itself still retains the original, unresolved input.
      const encodedSafe = encodedChecks.has(check);
      let checkInput = input;
      if (!encodedSafe) {
        normalized ??= decodeWithoutOwnChecks(projectCheckInput(input), parseOptions);
        if (Result.isFailure(normalized)) {
          // A complete literal that cannot normalize is invalid. Unresolved expressions
          // can prevent normalization, so defer this Type-only check until resolution.
          if (partial && onlyMissingKeys(normalized.failure.issue)) continue;
          if (sources.size === 0) return normalized.failure.issue;
          continue;
        }
        checkInput = normalized.success;
      }
      if (sources.size === 0) {
        const result = run(check, checkInput, self, parseOptions);
        if (result !== undefined) return result;
        continue;
      }
      if (
        encodedSafe &&
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
      const result = run(check, encodedSafe ? projectCheckInput(input) : checkInput, self, parseOptions);
      if (result === undefined) continue;
      const dependsOnExpression = SchemaIssue.makeFormatterStandardSchemaV1()(result).issues.some(
        (issue) =>
          (issue.path ?? []).length === 0 ||
          expressionAtOrAbovePath(
            input,
            (issue.path ?? []).map((key) => (typeof key === "object" ? key.key : key)),
          ) ||
          [...sources].some((source) => issue.message.includes(source)),
      );
      if (!dependsOnExpression) return result;
    }
    return undefined;
  });
};
