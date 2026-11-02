import { Result, Schema } from "effect";
import type { ExpressionNode } from "../expressions/ast.ts";
import { containsReservedBinding } from "../expressions/bindings.ts";
import { parseExpressionEither } from "../expressions/parser.ts";
import { expressionScopeMembers, expressionTouchesOnlyScopes } from "../expressions/scopes.ts";
import { mergeValuesWithOrigins } from "../landofile/overlay-merge.ts";
import { type ValueWithOrigins, withValueOrigins } from "../landofile/overlay-origins.ts";
import { validateSnapshotTemplate } from "../recipes/snapshot-template.ts";
import { LandofileAuthoringFragmentWire } from "./landofile-authoring.ts";
import { directiveMember } from "./landofile-directive-codec.ts";
import { LandofileSourceValue } from "./landofile-source.ts";
import { LandofileShape } from "./landofile.ts";
import { type RecipeSourceCompileError, recipeSourceFailure } from "./recipe-source-error.ts";
import { lowerSourceConfig, validateSourceConfig } from "./recipe-source-literals.ts";
import type { RecipeConfigLayer, RecipeSource } from "./recipe-source.ts";

export const RECIPE_SOURCE_VARIANT_BUDGET = 256;

export const compileSourceCondition = (
  source: RecipeSource,
  when: string,
): Result.Result<ExpressionNode, RecipeSourceCompileError> => {
  const parsed = parseExpressionEither(when.includes("{{") ? when : `{{ ${when} }}`, {
    filePath: `recipe:${source.id}`,
  });
  if (Result.isFailure(parsed) || !parsed.success.whole || parsed.success.segments.length !== 1)
    return Result.fail(recipeSourceFailure(source.id, "condition-invalid", "when"));
  const segment = parsed.success.segments[0];
  if (
    segment?.kind !== "InterpolationSegment" ||
    !expressionTouchesOnlyScopes(segment.expression, ["options"])
  )
    return Result.fail(recipeSourceFailure(source.id, "condition-invalid", "when"));
  const members = expressionScopeMembers(segment.expression, "options");
  if (
    !members.analyzable ||
    [...members.members].some((name) => {
      const option = source.options?.[name];
      return (
        !Object.hasOwn(source.options ?? {}, name) ||
        option?.type === undefined ||
        option.type.kind === "secret"
      );
    })
  )
    return Result.fail(recipeSourceFailure(source.id, "condition-invalid", "when"));
  const valid = validateSnapshotTemplate(source.id, { expression: segment.expression });
  return Result.isFailure(valid)
    ? Result.fail(recipeSourceFailure(source.id, "condition-invalid", "when"))
    : Result.succeed(segment.expression);
};

// ==== Merge authored branches before emitting AST; evaluated data never re-enters this pass
export const compileSourceLayers = (
  source: RecipeSource,
  layers: readonly RecipeConfigLayer[],
): Result.Result<ExpressionNode, RecipeSourceCompileError> => {
  const conditionalCount = layers.filter((layer) => layer.when !== undefined).length;
  if (conditionalCount > Math.log2(RECIPE_SOURCE_VARIANT_BUDGET))
    return Result.fail(recipeSourceFailure(source.id, "variant-budget", "variants"));
  const prepared: { value: ValueWithOrigins<number>; condition?: ExpressionNode }[] = [];
  for (const [index, layer] of layers.entries()) {
    const checked = Schema.decodeUnknownResult(LandofileAuthoringFragmentWire)(layer.config, {
      onExcessProperty: "error",
    });
    if (Result.isFailure(checked) || containsReservedBinding(layer.config))
      return Result.fail(recipeSourceFailure(source.id, "config-invalid", `configLayers.${index}.config`));
    const native = Schema.decodeUnknownResult(
      Schema.make<Schema.Codec<unknown>>(directiveMember(Schema.Unknown, false).ast),
    )(layer.config);
    if (Result.isFailure(native))
      return Result.fail(recipeSourceFailure(source.id, "config-invalid", `configLayers.${index}`));
    const value = withValueOrigins(native.success, () => index);
    const materialized = mergeValuesWithOrigins(
      LandofileShape,
      withValueOrigins({}, () => -1),
      value,
    );
    const json = Schema.decodeUnknownResult(LandofileSourceValue)(materialized.value);
    if (Result.isFailure(json))
      return Result.fail(recipeSourceFailure(source.id, "config-invalid", `configLayers.${index}`));
    const validated = validateSourceConfig(source, json.success);
    if (Result.isFailure(validated)) return Result.fail(validated.failure);
    if (layer.when === undefined) prepared.push({ value });
    else {
      const condition = compileSourceCondition(source, layer.when);
      if (Result.isFailure(condition)) return condition;
      prepared.push({ value, condition: condition.success });
    }
  }
  const visit = (
    index: number,
    merged: ValueWithOrigins<number>,
  ): Result.Result<ExpressionNode, RecipeSourceCompileError> => {
    const layer = prepared[index];
    if (layer === undefined) {
      const json = Schema.decodeUnknownResult(LandofileSourceValue)(merged.value);
      return Result.isFailure(json)
        ? Result.fail(recipeSourceFailure(source.id, "config-invalid", "config"))
        : lowerSourceConfig(source.id, json.success);
    }
    const higher = mergeValuesWithOrigins(LandofileShape, merged, layer.value);
    if (layer.condition === undefined) return visit(index + 1, higher);
    const consequent = visit(index + 1, higher);
    if (Result.isFailure(consequent)) return consequent;
    const alternate = visit(index + 1, merged);
    if (Result.isFailure(alternate)) return alternate;
    return Result.succeed({
      kind: "Conditional",
      test: structuredClone(layer.condition),
      consequent: consequent.success,
      alternate: alternate.success,
    });
  };
  return visit(
    0,
    withValueOrigins({}, () => -1),
  );
};
