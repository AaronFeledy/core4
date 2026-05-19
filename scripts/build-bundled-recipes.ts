#!/usr/bin/env bun
/**
 * Regenerate `core/src/recipes/bundled.ts` from `core/build.config.ts`.
 *
 * Inputs:
 *   - `core/src/recipes/builtin/<id>/manifest.ts` (one module per bundled recipe;
 *     exports `<idCamel>RecipeSource`, `<idCamel>RecipeYaml`, and the id constant)
 *   - `core/build.config.ts` (the "ship list")
 *
 * Output:
 *   - `core/src/recipes/bundled.ts` — a static `import` graph the compiled
 *     binary can use without dynamic `import()` and without runtime disk
 *     reads against the recipe templates.
 *
 * Drift gate: `bun run codegen` re-runs this generator and
 * `git diff --exit-code` fails if the output drifts.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { buildConfig } from "../core/build.config.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "core/src/recipes/bundled.ts");

const HEADER = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-bundled-recipes.ts\`.
 *
 * Source of truth: \`core/build.config.ts\` (the "ship list").
 *
 * The default Lando v4 binary is built with \`bun build --compile\`. Compiled
 * binaries cannot dynamically \`import()\` arbitrary files at runtime, so
 * bundled recipe manifests are statically imported here. The compiled binary
 * does NOT read recipe.yml from disk at runtime — the manifest text is
 * embedded in the binary as a TypeScript string constant.
 */
`;

const toCamelPrefix = (id: string): string =>
  id
    .split(/[^a-zA-Z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");

const renderModule = (entries: typeof buildConfig.bundledRecipes): string => {
  const sectionTypes = [
    "export interface BundledRecipe {",
    "  readonly id: string;",
    "  readonly source: string;",
    "  readonly manifestYaml: string;",
    "}",
    "",
  ].join("\n");

  if (entries.length === 0) {
    return [
      HEADER,
      "",
      sectionTypes,
      "export const BUNDLED_RECIPES: ReadonlyArray<BundledRecipe> = [];",
      "",
    ].join("\n");
  }

  const imports: Array<string> = [];
  const rows: Array<string> = [];

  for (const entry of entries) {
    const manifestPath = resolve(REPO_ROOT, "core/src/recipes/builtin", entry.id, "manifest.ts");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Bundled recipe "${entry.id}" is declared in core/build.config.ts but ` +
          `core/src/recipes/builtin/${entry.id}/manifest.ts does not exist.`,
      );
    }
    const prefix = toCamelPrefix(entry.id);
    const idConst = `${prefix.replace(/([A-Z])/gu, "_$1").toUpperCase()}_RECIPE_ID`;
    const sourceConst = `${prefix}RecipeSource`;
    const yamlConst = `${prefix}RecipeYaml`;

    imports.push(
      `import { ${idConst}, ${sourceConst}, ${yamlConst} } from "./builtin/${entry.id}/manifest.ts";`,
    );
    rows.push(
      [
        "  {",
        `    id: ${idConst},`,
        `    source: ${sourceConst},`,
        `    manifestYaml: ${yamlConst},`,
        "  },",
      ].join("\n"),
    );
  }

  return [
    HEADER,
    "",
    ...imports,
    "",
    sectionTypes,
    "export const BUNDLED_RECIPES: ReadonlyArray<BundledRecipe> = [",
    rows.join("\n"),
    "];",
    "",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const content = renderModule(buildConfig.bundledRecipes);
  await Bun.write(OUTPUT, content);

  const format = Bun.spawn({
    cmd: [process.execPath, "x", "biome", "format", "--write", OUTPUT],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await format.exited;
  if (exitCode !== 0) {
    throw new Error(`biome format exited with code ${exitCode} for ${OUTPUT}`);
  }

  console.log(`[bundled-recipes] wrote ${OUTPUT} (${buildConfig.bundledRecipes.length} entries)`);
};

await main();
