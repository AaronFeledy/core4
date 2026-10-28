import { Result, Schema } from "effect";
import { RecipeSnapshotError } from "../errors/recipe.ts";
import type { ExpressionNode } from "../expressions/ast.ts";
import { containsReservedBinding } from "../expressions/bindings.ts";
import { evaluateExpressionEither, evaluateTemplateEither } from "../expressions/evaluator.ts";
import { parseExpressionEither } from "../expressions/parser.ts";
import { expressionInterpolationsTouchOnlyScopes } from "../expressions/scopes.ts";
import {
  type CompilationContext,
  ComposedCompiledLandofile,
  type ParsedPendingSite,
} from "../schema/compiled-landofile.ts";
import { LandofileSourceValue } from "../schema/landofile-source.ts";
import type { RecipeOptionValue } from "../schema/recipe-identity.ts";
import type { RecipeSnapshot } from "../schema/recipe-snapshot.ts";
import type { ValidationIssuePath } from "../schema/validation-issue.ts";
import { SNAPSHOT_RENDER_BUDGET, renderRecipeSnapshot, validateSnapshotTemplate } from "./snapshot-render.ts";
import { decodeSnapshotSourceLiterals } from "./snapshot-source.ts";

type LiteralCompilation = { readonly value: unknown; readonly sites: readonly ParsedPendingSite[] };

export const renderCompiledRecipeSnapshot = (
  snapshot: RecipeSnapshot,
  options: Record<string, RecipeOptionValue>,
  context: CompilationContext,
): Result.Result<ComposedCompiledLandofile, RecipeSnapshotError> => {
  const recipeId = snapshot.identity.recipeId;
  const fail = (path: ValidationIssuePath, message: string) =>
    new RecipeSnapshotError({
      recipeId,
      reason: "render-output-invalid",
      path: path.join("."),
      message,
      remediation: "Correct the authored snapshot literal or use plain option/helper data.",
    });
  if (containsReservedBinding(options) || containsReservedBinding(snapshot.defaults))
    return Result.fail(fail(["options"], "Recipe options cannot contain reserved binding objects."));
  const structure = validateSnapshotTemplate(recipeId, snapshot.template);
  if (Result.isFailure(structure)) return Result.fail(structure.failure);
  const validated = renderRecipeSnapshot(snapshot, options);
  if (Result.isFailure(validated) && validated.failure.reason === "budget-exceeded")
    return Result.fail(validated.failure);
  const source = decodeSnapshotSourceLiterals(snapshot.template.expression);
  if (Result.isFailure(source)) return Result.fail(fail(["template", "expression"], source.failure));
  const literals = new Map<ExpressionNode, LiteralCompilation>();
  const sourcePaths = new Map<ExpressionNode, ValidationIssuePath>();
  const compile = (
    node: ExpressionNode,
    path: ValidationIssuePath,
    sourcePath: ValidationIssuePath,
  ): Result.Result<void, RecipeSnapshotError> => {
    sourcePaths.set(node, sourcePath);
    switch (node.kind) {
      case "Literal": {
        if (typeof node.value !== "string" || (!node.value.includes("{{") && !node.value.includes("${")))
          return Result.succeed(undefined);
        const parsed = parseExpressionEither(node.value, {
          filePath: `recipe:${recipeId}`,
          bareShellParameters: "preserve",
        });
        if (Result.isFailure(parsed)) return Result.fail(fail(sourcePath, parsed.failure.message));
        const bindingSite =
          (path[0] === "services" &&
            ((path[2] === "environment" && path.length === 4) ||
              (path[2] === "creds" && (path[3] === "password" || path[3] === "rootPassword")) ||
              path[2] === "password")) ||
          (path[0] === "tooling" && path.includes("env"));
        if (
          !expressionInterpolationsTouchOnlyScopes(parsed.success, [
            "app",
            "proxy",
            "recipe",
            "env",
            "services",
            ...(bindingSite ? ["secrets"] : []),
          ]) ||
          parsed.success.segments.some(
            (segment) =>
              segment.kind === "ShellParamSegment" || (segment.kind === "SecretRefSegment" && !bindingSite),
          )
        )
          return Result.fail(
            fail(sourcePath, "Unsupported authored snapshot expression at this destination."),
          );
        const active = parsed.success.segments.some(
          (segment) => segment.kind === "InterpolationSegment" || segment.kind === "SecretRefSegment",
        );
        if (!active) {
          const evaluated = evaluateTemplateEither(parsed.success, {});
          if (Result.isFailure(evaluated)) return Result.fail(fail(sourcePath, evaluated.failure.message));
          literals.set(node, { value: evaluated.success, sites: [] });
        } else {
          const source = { file: `recipe:${recipeId}`, layer: "canonical" as const, path: sourcePath };
          literals.set(node, {
            value: node.value,
            sites: [{ id: JSON.stringify(source), source, path, template: parsed.success }],
          });
        }
        return Result.succeed(undefined);
      }
      case "ObjectLiteral":
        for (const [index, entry] of node.entries.entries()) {
          const result = compile(
            entry.value,
            [...path, entry.key],
            [...sourcePath, "entries", index, "value"],
          );
          if (Result.isFailure(result)) return result;
        }
        return Result.succeed(undefined);
      case "ArrayLiteral":
        for (const [index, entry] of node.elements.entries()) {
          const result = compile(entry, [...path, index], [...sourcePath, "elements", index]);
          if (Result.isFailure(result)) return result;
        }
        return Result.succeed(undefined);
      case "Conditional":
        for (const [key, child] of [
          ["consequent", node.consequent],
          ["alternate", node.alternate],
        ] as const) {
          const result = compile(child, path, [...sourcePath, key]);
          if (Result.isFailure(result)) return result;
        }
        return Result.succeed(undefined);
      case "Call":
      case "Access":
      case "Path":
        return Result.succeed(undefined);
      default:
        return node satisfies never;
    }
  };
  const compiled = compile(source.success, [], ["template", "expression"]);
  if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
  const pendingSites: ParsedPendingSite[] = [];
  const evaluate = (node: ExpressionNode): Result.Result<unknown, RecipeSnapshotError> => {
    switch (node.kind) {
      case "Literal": {
        const literal = literals.get(node);
        if (literal !== undefined) pendingSites.push(...literal.sites);
        return Result.succeed(literal?.value ?? node.value);
      }
      case "ObjectLiteral": {
        const entries: [string, unknown][] = [];
        for (const entry of node.entries) {
          const result = evaluate(entry.value);
          if (Result.isFailure(result)) return result;
          entries.push([entry.key, result.success]);
        }
        const value = Object.fromEntries(entries);
        return containsReservedBinding(value)
          ? Result.fail(
              fail(
                sourcePaths.get(node) ?? [],
                "Snapshot literal objects cannot construct reserved bindings.",
              ),
            )
          : Result.succeed(value);
      }
      case "ArrayLiteral": {
        const values: unknown[] = [];
        for (const child of node.elements) {
          const result = evaluate(child);
          if (Result.isFailure(result)) return result;
          values.push(result.success);
        }
        return Result.succeed(values);
      }
      case "Conditional": {
        const test = evaluateExpressionEither(
          node.test,
          { options: { ...snapshot.defaults, ...options } },
          { budget: SNAPSHOT_RENDER_BUDGET },
        );
        if (Result.isFailure(test)) return Result.fail(fail([], test.failure.message));
        return evaluate(test.success ? node.consequent : node.alternate);
      }
      case "Call":
      case "Path":
      case "Access":
        return evaluateExpressionEither(
          node,
          { options: { ...snapshot.defaults, ...options } },
          { budget: SNAPSHOT_RENDER_BUDGET },
        ).pipe(Result.mapError((error) => fail(sourcePaths.get(node) ?? [], error.message)));
      default:
        return node satisfies never;
    }
  };
  const rendered = evaluate(source.success);
  if (Result.isFailure(rendered)) return Result.fail(rendered.failure);
  if (Result.isFailure(validated)) return Result.fail(validated.failure);
  if (containsReservedBinding(rendered.success))
    return Result.fail(fail([], "Snapshot output contains reserved binding objects."));
  const document = Schema.decodeUnknownResult(LandofileSourceValue)(rendered.success);
  if (Result.isFailure(document)) return Result.fail(fail([], "Snapshot output must be finite JSON data."));
  return Result.succeed(
    ComposedCompiledLandofile.make({ stage: "composed", document: document.success, pendingSites, context }),
  );
};
