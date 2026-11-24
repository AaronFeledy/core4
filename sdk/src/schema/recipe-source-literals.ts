import { Result } from "effect";
import type { ExpressionNode, ExpressionTemplate } from "../expressions/ast.ts";
import { evaluateExpressionEither } from "../expressions/evaluator.ts";
import { parseExpressionEither } from "../expressions/parser.ts";
import { expressionInterpolationsTouchOnlyScopes, expressionScopeMembers } from "../expressions/scopes.ts";
import {
  INVOCATION_SCOPES,
  executableExpressionPath,
  servicePortExpression,
} from "../landofile/execution-sites.ts";
import type { LandofileSourceValue } from "./landofile-source.ts";
import type { RecipeSource } from "./recipe-source.ts";
import { type RecipeSourceCompileError, recipeSourceFailure } from "./recipe-source-error.ts";

/**
 * Whether an authored recipe config string at `path` reads only scopes the resulting Landofile admits
 * there: load and plan scopes everywhere, invocation scopes at executable tooling and event positions,
 * the self `service` fact where a service process may read it, and secrets only at binding sites.
 */
export const recipeConfigExpressionAdmitted = (
  template: ExpressionTemplate,
  path: readonly (string | number)[],
): boolean => {
  const self = servicePortExpression(template, path);
  const bindingSite =
    (path[0] === "services" &&
      ((path[2] === "environment" && path.length === 4) ||
        (path[2] === "creds" && (path[3] === "password" || path[3] === "rootPassword")))) ||
    (path[0] === "tooling" && path.includes("env"));
  return (
    expressionInterpolationsTouchOnlyScopes(template, [
      "app",
      "recipe",
      "env",
      "services",
      "proxy",
      ...(executableExpressionPath(path) ? INVOCATION_SCOPES : []),
      ...(self === "supported" || self === "route-fact" ? ["service"] : []),
      ...(bindingSite ? ["secrets"] : []),
    ]) &&
    !template.segments.some(
      (segment) =>
        segment.kind === "ShellParamSegment" || (segment.kind === "SecretRefSegment" && !bindingSite),
    )
  );
};

export const validateSourceConfig = (
  source: RecipeSource,
  value: LandofileSourceValue,
  path: readonly (string | number)[] = [],
): Result.Result<void, RecipeSourceCompileError> => {
  const fail = () => Result.fail(recipeSourceFailure(source.id, "config-invalid", path));
  if (typeof value === "string") {
    const parsed = parseExpressionEither(value, {
      filePath: `recipe:${source.id}`,
      bareShellParameters: "preserve",
    });
    if (Result.isFailure(parsed)) return fail();
    if (!recipeConfigExpressionAdmitted(parsed.success, path)) return fail();
    const references = expressionScopeMembers(parsed.success, "recipe");
    if (
      !references.analyzable ||
      [...references.members].some((name) => {
        const option = source.options?.[name];
        return (
          name !== "name" &&
          (!Object.hasOwn(source.options ?? {}, name) ||
            option?.type === undefined ||
            option.type.kind === "secret")
        );
      })
    )
      return fail();
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const result = validateSourceConfig(source, child, [...path, Array.isArray(value) ? Number(key) : key]);
      if (Result.isFailure(result)) return result;
    }
  }
  return Result.succeed(undefined);
};

export const lowerSourceConfig = (
  recipeId: string,
  value: LandofileSourceValue,
): Result.Result<ExpressionNode, RecipeSourceCompileError> => {
  if (typeof value === "string" && value.startsWith("lando:authoring:base64:")) {
    const encoded = evaluateExpressionEither(
      { kind: "Call", callee: "b64encode", args: [{ kind: "Literal", value }] },
      {},
    );
    if (Result.isFailure(encoded) || typeof encoded.success !== "string")
      return Result.fail(recipeSourceFailure(recipeId, "config-invalid", ["config"]));
    return Result.succeed({ kind: "Literal", value: `lando:authoring:base64:${encoded.success}` });
  }
  if (value === null || typeof value !== "object") return Result.succeed({ kind: "Literal", value });
  if (Array.isArray(value)) {
    const elements: ExpressionNode[] = [];
    for (const child of value) {
      const lowered = lowerSourceConfig(recipeId, child);
      if (Result.isFailure(lowered)) return lowered;
      elements.push(lowered.success);
    }
    return Result.succeed({ kind: "ArrayLiteral", elements });
  }
  const entries: { key: string; value: ExpressionNode }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const lowered = lowerSourceConfig(recipeId, child);
    if (Result.isFailure(lowered)) return lowered;
    entries.push({ key, value: lowered.success });
  }
  return Result.succeed({ kind: "ObjectLiteral", entries });
};
