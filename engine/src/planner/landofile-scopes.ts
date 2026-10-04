import { Effect } from "effect";

import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import {
  LOAD_DEFERRED_EXPRESSION_SCOPES,
  hostExpressionEnvironment,
  materializeExpressionScopes,
  recipeOptionScope,
} from "@lando/landofile/recipe-expressions";
import { ConfigExpressionError } from "@lando/sdk/errors";
import type { GlobalConfig, LandofileShape, ValidationIssuePath } from "@lando/sdk/schema";

import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { normalizeAppSlug } from "./naming.ts";

export interface MaterializeLandofileScopesInput {
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly landofilePath: string;
  readonly globalConfig: Readonly<{ readonly proxy?: GlobalConfig["proxy"] }> | undefined;
}

export interface MaterializedLandofileScopes {
  /** The Landofile with every deferred-scope expression replaced by its value. */
  readonly landofile: LandofileShape;
  readonly appSlug: string;
  readonly defaultDomain: string;
}

/**
 * Resolve the expression scopes the loader deferred to the planner.
 *
 * The loader leaves `app` and `proxy` sites (and any site mixing them with
 * `recipe`/`env`) untouched because only the planner knows the app slug and
 * the proxy default domain. This pass evaluates those sites across the whole
 * document so service configuration, environment, and tooling see the same
 * values route hostnames do. `app.name` is the normalized slug, matching the
 * route-hostname pass. A document with no deferred sites is returned as-is so
 * object identity and provenance are untouched on the common path.
 */
const ARRAY_INDEX_SEGMENT = /^(?:0|[1-9][0-9]*)$/;

/**
 * Recover the structured issue path from a {@link ConfigExpressionError}
 * raised by {@link materializeLandofileScopes}.
 *
 * The error carries the path as dotted text; array positions were written as
 * decimal indexes, so they come back as numbers the way `ValidationIssuePath`
 * documents them.
 */
export const configExpressionIssuePath = (error: ConfigExpressionError): ValidationIssuePath =>
  error.path.length === 0
    ? []
    : error.path.split(".").map((segment) => (ARRAY_INDEX_SEGMENT.test(segment) ? Number(segment) : segment));

export const materializeLandofileScopes = (
  input: MaterializeLandofileScopesInput,
): Effect.Effect<MaterializedLandofileScopes, ConfigExpressionError> => {
  const appSlug = normalizeAppSlug(input.landofile.name ?? "app", input.appRoot);
  const defaultDomain = readProxyDefaultDomain(input.globalConfig ?? {});
  const materialized = materializeExpressionScopes(input.landofile, input.landofilePath, {
    scopes: LOAD_DEFERRED_EXPRESSION_SCOPES,
    context: {
      app: { name: appSlug, slug: appSlug },
      proxy: { defaultDomain },
      env: hostExpressionEnvironment(),
      recipe: recipeOptionScope(input.landofile),
    },
  });
  const unresolved = materialized.unresolved[0];
  if (unresolved !== undefined) {
    return Effect.fail(
      new ConfigExpressionError({
        message: unresolved.reason,
        expression: unresolved.expression,
        path: unresolved.path.join("."),
        filePath: input.landofilePath,
        remediation:
          "Fix the Landofile expression or provide the referenced app, proxy, recipe, or environment value.",
      }),
    );
  }
  if (materialized.value !== input.landofile) {
    copyLandofileProvenance(input.landofile, materialized.value);
  }
  return Effect.succeed({ landofile: materialized.value, appSlug, defaultDomain });
};
