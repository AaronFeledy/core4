import { expressionScopeMembers } from "@lando/sdk/expressions";
import type { LoadScopedLandofile } from "@lando/sdk/schema";

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
