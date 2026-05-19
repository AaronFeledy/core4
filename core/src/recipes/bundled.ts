/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bundled-recipes.ts`.
 *
 * Source of truth: `core/build.config.ts` (the "ship list").
 *
 * The default Lando v4 binary is built with `bun build --compile`. Compiled
 * binaries cannot dynamically `import()` arbitrary files at runtime, so
 * bundled recipe manifests are statically imported here. The compiled binary
 * does NOT read recipe.yml from disk at runtime — the manifest text is
 * embedded in the binary as a TypeScript string constant.
 */

import {
  NODE_POSTGRES_RECIPE_ID,
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "./builtin/node-postgres/manifest.ts";

export interface BundledRecipe {
  readonly id: string;
  readonly source: string;
  readonly manifestYaml: string;
}

export const BUNDLED_RECIPES: ReadonlyArray<BundledRecipe> = [
  {
    id: NODE_POSTGRES_RECIPE_ID,
    source: nodePostgresRecipeSource,
    manifestYaml: nodePostgresRecipeYaml,
  },
];
