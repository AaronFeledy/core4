import { ConfigExpressionError, LandofileValidationError } from "@lando/sdk/errors";
import {
  expressionInterpolationsTouchOnlyScopes,
  expressionScopeMembers,
  expressionTouchesOnlyScopes,
} from "@lando/sdk/expressions";
import { isPlainRecord, mergeLandofiles, withValueOrigins } from "@lando/sdk/landofile";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { consumeSites, survivingSites } from "../compiled-sites.ts";
import { copyLandofileProvenance } from "../copy-provenance.ts";
import { includeConditionPath } from "../include-condition-shape.ts";
import { loadPathBlocked } from "../load-failures.ts";
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
        recorder: scope.recorder,
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
  const surviving = survivingSites(origins, scope.pendingSites ?? []);
  const sites = scope.siteFilter === undefined ? surviving : surviving.filter(scope.siteFilter);
  if (scope.recorder !== undefined) {
    let document: unknown = normalized.value;
    const consumed = new Set<string>();
    for (const site of sites) {
      if (loadPathBlocked(scope.recorder, site.source)) continue;
      const condition = includeConditionPath(site.path);
      if (
        condition &&
        (!site.template.whole || !expressionTouchesOnlyScopes(site.template, ["recipe", "env"]))
      ) {
        scope.recorder.record(
          new ConfigExpressionError({
            message: "An include condition must be a whole-value expression over recipe and env.",
            path: site.source.path,
            source: site.source,
            expression: JSON.stringify(site.template),
            filePath: "file" in site.source ? site.source.file : _file,
            remediation: "Use a boolean or a whole-value {{ ... }} expression over recipe and env.",
          }),
          site.source,
        );
        consumed.add(site.id);
        continue;
      }
      const references = expressionScopeMembers(site.template, "recipe");
      const recipeDependent = !references.analyzable || references.members.size > 0;
      if (!scope.recorder.recipeAvailable && recipeDependent) {
        scope.recorder.blocked.push(site.source);
        continue;
      }
      if (
        scope.recipe === undefined &&
        recipeDependent &&
        expressionInterpolationsTouchOnlyScopes(site.template, ["recipe", "env"])
      ) {
        scope.recorder.record(
          new ConfigExpressionError({
            message: "The Landofile records no recipe options.",
            path: condition ? site.source.path : site.path,
            source: site.source,
            expression: JSON.stringify(site.template),
            filePath: "file" in site.source ? site.source.file : _file,
            remediation: "Record recipe options before using recipe expressions.",
          }),
          site.source,
        );
        consumed.add(site.id);
        continue;
      }
      const result = consumeSites({
        document,
        pendingSites: [site],
        context: { env: scope.env, recipe: scope.recipe },
        scopes: ["recipe", "env"],
      });
      if (Result.isFailure(result)) {
        scope.recorder.record(
          condition
            ? new ConfigExpressionError({
                message: result.failure.message,
                path: site.source.path,
                source: site.source,
                expression: result.failure.expression,
                filePath: result.failure.filePath,
                remediation: result.failure.remediation,
              })
            : result.failure,
          site.source,
        );
        consumed.add(site.id);
        continue;
      }
      if (condition) {
        const resolved = site.path.reduce<unknown>(
          (value, key) =>
            isPlainRecord(value) || Array.isArray(value) ? Reflect.get(value, key) : undefined,
          result.success.document,
        );
        if (typeof resolved !== "boolean") {
          scope.recorder.record(
            new ConfigExpressionError({
              message: "An include condition must resolve to a boolean.",
              path: site.source.path,
              source: site.source,
              expression: JSON.stringify(site.template),
              filePath: "file" in site.source ? site.source.file : _file,
              remediation: "Return true or false; use boolean() to convert environment text.",
            }),
            site.source,
          );
          consumed.add(site.id);
          continue;
        }
      }
      document = result.success.document;
      if (result.success.pendingSites.length === 0) consumed.add(site.id);
    }
    if (scope.pendingSites !== undefined)
      for (let index = scope.pendingSites.length - 1; index >= 0; index--)
        if (consumed.has(scope.pendingSites[index]?.id ?? "")) scope.pendingSites.splice(index, 1);
    return isPlainRecord(document)
      ? rememberOrigins(copyLandofileProvenance(value, document), origins)
      : document;
  }
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
        path: unavailable.path,
        source: unavailable.source,
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
