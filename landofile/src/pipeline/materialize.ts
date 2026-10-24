import { ConfigExpressionError, LandofileValidationError } from "@lando/sdk/errors";
import { expressionInterpolationsTouchOnlyScopes } from "@lando/sdk/expressions";
import { isPlainRecord, mergeLandofiles, withValueOrigins } from "@lando/sdk/landofile";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import { Effect } from "effect";
import { consumeSites, survivingSites } from "../compiled-sites.ts";
import { copyLandofileProvenance } from "../copy-provenance.ts";
import { normalizeEnvironmentSites } from "../normalize-environment-sites.ts";
import {
  type LandofileLoadScope,
  hostExpressionEnvironment,
  recipeOptionScope,
} from "../recipe-expressions.ts";
import { getOrigins, rememberOrigins } from "./origins.ts";

export type { LandofileLoadScope } from "../recipe-expressions.ts";
export const buildLandofileLoadScope = Effect.fnUntraced(function* (
  layers: readonly { readonly file: string; readonly value: unknown }[],
  env: Readonly<Record<string, string>> = hostExpressionEnvironment(),
  pendingSites: ParsedPendingSite[] = [],
) {
  const merged = mergeLandofiles(
    layers.map(({ value }) =>
      isPlainRecord(value) && Object.hasOwn(value, "recipe") ? { recipe: value.recipe } : {},
    ),
  );
  return { env, recipe: recipeOptionScope(merged), pendingSites };
});

export const materializeLandofileLayer = Effect.fnUntraced(function* (
  _file: string,
  value: unknown,
  scope: LandofileLoadScope,
) {
  if (!isPlainRecord(value)) return value;
  const normalized = yield* Effect.try({
    try: () =>
      normalizeEnvironmentSites({
        value,
        origins:
          getOrigins(value) ??
          withValueOrigins(value, (path) => ({ file: _file, layer: "canonical" as const, path })).origins,
      }),
    catch: (cause) => {
      if (cause instanceof LandofileValidationError) return cause;
      throw cause;
    },
  });
  const origins = normalized.origins;
  const sites = survivingSites(origins, scope.pendingSites ?? []);
  const unavailable =
    scope.recipe === undefined
      ? sites.find(
          (site) =>
            expressionInterpolationsTouchOnlyScopes(site.template, ["recipe", "env"]) &&
            !expressionInterpolationsTouchOnlyScopes(site.template, ["env"]),
        )
      : undefined;
  if (unavailable !== undefined)
    return yield* Effect.fail(
      new ConfigExpressionError({
        message: "The Landofile records no recipe options.",
        path: unavailable.path.join("."),
        expression: JSON.stringify(unavailable.template),
        filePath: "file" in unavailable.source ? unavailable.source.file : _file,
        remediation: "Record recipe options before using recipe expressions.",
      }),
    );
  const result = yield* Effect.fromResult(
    consumeSites({
      document: normalized.value,
      pendingSites: sites,
      context: { env: scope.env, recipe: scope.recipe },
      scopes: ["recipe", "env"],
    }),
  );
  const remaining = new Set(result.pendingSites.map((site) => site.id));
  const consumed = new Set(sites.filter((site) => !remaining.has(site.id)).map((site) => site.id));
  if (scope.pendingSites !== undefined)
    for (let index = scope.pendingSites.length - 1; index >= 0; index--)
      if (consumed.has(scope.pendingSites[index]?.id ?? "")) scope.pendingSites.splice(index, 1);
  return isPlainRecord(result.document)
    ? rememberOrigins(copyLandofileProvenance(value, result.document), normalized.origins)
    : result.document;
});
