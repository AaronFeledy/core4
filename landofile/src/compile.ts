import type { LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import {
  type LandofileDecodedOverlay,
  decodeLandofileLayer,
  isPlainRecord,
  mergeLandofiles,
} from "@lando/sdk/landofile";
import { validationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  type LandofileLoadScope,
  hostExpressionEnvironment,
  materializeLoadScopeExpressions,
  recipeOptionScope,
} from "./recipe-expressions.ts";
import { landofileValidationError, validateLandofile } from "./validation.ts";

export type { LandofileLoadScope } from "./recipe-expressions.ts";

export const buildLandofileLoadScope = Effect.fnUntraced(function* (
  layers: readonly { readonly file: string; readonly value: unknown }[],
  env: Readonly<Record<string, string>> = hostExpressionEnvironment(),
): Effect.fn.Return<LandofileLoadScope, LandofileParseError | LandofileValidationError> {
  const projections = yield* Effect.forEach(layers, ({ file, value }) =>
    decodeLandofileLayer(
      file,
      isPlainRecord(value) && Object.hasOwn(value, "recipe") ? { recipe: value.recipe } : {},
      (plain) => validateLandofile(file, plain),
    ),
  );
  return { env, recipe: recipeOptionScope(mergeLandofiles(projections)) };
});

export const materializeLandofileLayer = Effect.fnUntraced(function* (
  file: string,
  value: unknown,
  scope: LandofileLoadScope,
) {
  const result = materializeLoadScopeExpressions(value, file, scope);
  if (result.unresolved.length > 0) {
    return yield* Effect.fail(
      landofileValidationError(
        file,
        result.unresolved.map(({ path, reason }) => validationIssue(path, reason)),
        {
          headline: "Landofile cannot resolve configuration expressions",
          remediation:
            "Set the missing recipe option or environment variable, add a default(), or replace the expression with a literal value.",
        },
      ),
    );
  }
  return result.value;
});

export const compileLandofileLayer: (
  file: string,
  value: unknown,
  scope: LandofileLoadScope,
) => Effect.Effect<LandofileDecodedOverlay, LandofileParseError | LandofileValidationError> =
  Effect.fnUntraced(function* (file: string, value: unknown, scope: LandofileLoadScope) {
    const materialized = yield* materializeLandofileLayer(file, value, scope);
    return yield* decodeLandofileLayer(file, materialized, (plain) => validateLandofile(file, plain));
  });
