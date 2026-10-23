import { isPlainRecord, mergeLandofiles, valueOriginAt } from "@lando/sdk/landofile";
import { validationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";
import { copyLandofileProvenance } from "../copy-provenance.ts";
import {
  type LandofileLoadScope,
  hostExpressionEnvironment,
  materializeLoadScopeExpressions,
  recipeOptionScope,
} from "../recipe-expressions.ts";
import { landofileValidationError } from "../validation.ts";
import { getOrigins } from "./origins.ts";

export type { LandofileLoadScope } from "../recipe-expressions.ts";
export const buildLandofileLoadScope = Effect.fnUntraced(function* (
  layers: readonly { readonly file: string; readonly value: unknown }[],
  env: Readonly<Record<string, string>> = hostExpressionEnvironment(),
) {
  const merged = mergeLandofiles(
    layers.map(({ value }) =>
      isPlainRecord(value) && Object.hasOwn(value, "recipe") ? { recipe: value.recipe } : {},
    ),
  );
  return { env, recipe: recipeOptionScope(merged) };
});

export const materializeLandofileLayer = Effect.fnUntraced(function* (
  file: string,
  value: unknown,
  scope: LandofileLoadScope,
) {
  const result = materializeLoadScopeExpressions(value, file, scope);
  const origins = isPlainRecord(value) ? getOrigins(value) : undefined;
  if (result.unresolved.length > 0) {
    return yield* Effect.fail(
      landofileValidationError(
        file,
        result.unresolved.map(({ path, reason }) => ({
          ...validationIssue(path, reason),
          ...(origins === undefined ? {} : { source: valueOriginAt(origins, path).source }),
        })),
        {
          headline: "Landofile cannot resolve configuration expressions",
          remediation:
            "Set the missing recipe option or environment variable, add a default(), or replace the expression with a literal value.",
        },
      ),
    );
  }
  return isPlainRecord(value) && isPlainRecord(result.value)
    ? copyLandofileProvenance(value, result.value)
    : result.value;
});
