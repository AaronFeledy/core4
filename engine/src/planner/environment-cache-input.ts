import type { EnvironmentDependencies } from "@lando/landofile/environment-dependencies";
import { unionEnvironmentDependencies } from "@lando/landofile/environment-dependencies";
import {
  getLandofileEnvironmentDependencies,
  rememberLandofileEnvironmentDependencies,
} from "@lando/landofile/load-expression-provenance";
import { expressionScopeMembers } from "@lando/sdk/expressions";
import type { LoadScopedLandofile } from "@lando/sdk/schema";

export const rememberAppFeatureEnvironment = (
  compiled: LoadScopedLandofile,
  dependencies: EnvironmentDependencies,
): void => {
  rememberLandofileEnvironmentDependencies(
    compiled.document,
    unionEnvironmentDependencies(getLandofileEnvironmentDependencies(compiled.document), dependencies),
  );
};

/** Original static reads supplement materialized documents and bounded invocation captures.
 * Computed reads are represented by their materialized results, never by the whole host env.
 * Missing members remain absent, so lazy branches need not resolve them.
 */
export const environmentCacheInput = (compiled: LoadScopedLandofile) => {
  const names = new Set(
    compiled.pendingSites.flatMap((site) => [...expressionScopeMembers(site.template, "env").members]),
  );
  return Object.fromEntries(
    [...names].sort().flatMap((name) => {
      const value = compiled.context.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
};
