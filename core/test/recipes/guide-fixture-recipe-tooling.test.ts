import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { BUNDLED_RECIPE_SOURCES } from "../../src/recipes/builtin/source-catalog.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const Mapping = Schema.Record(Schema.String, Schema.Unknown);
const ToolingConfig = Schema.Struct({ tooling: Schema.optionalKey(Mapping) });

test("guide fixture copies retain every field of bundled recipe tools (#2401)", async () => {
  // Given: authored base and variant tools, including optional recipe tooling.
  const recipeTools = [...BUNDLED_RECIPE_SOURCES].flatMap(([recipeId, source]) =>
    [source.config, ...(source.variants ?? []).map(({ config }) => config)].flatMap((config) =>
      Object.entries(Schema.decodeUnknownSync(ToolingConfig)(config).tooling ?? {})
        .filter((entry): entry is [string, typeof Mapping.Type] => Schema.is(Mapping)(entry[1]))
        .map(([name, tool]) => ({ recipeId, name, tool })),
    ),
  );
  const fixtures = [
    ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.yml").scanSync({ cwd: repoRoot, dot: true }),
  ].sort();

  // When: a fixture identifies a copied tool by its recipe description.
  const differences: string[] = [];
  for (const fixture of fixtures) {
    const config = Schema.decodeUnknownSync(ToolingConfig)(
      Bun.YAML.parse(await Bun.file(resolve(repoRoot, fixture)).text()),
    );
    for (const [name, tool] of Object.entries(config.tooling ?? {})) {
      if (!Schema.is(Mapping)(tool)) continue;
      for (const recipe of recipeTools) {
        if (typeof tool.description !== "string" || tool.description !== recipe.tool.description) continue;
        const fields = [...new Set([...Object.keys(tool), ...Object.keys(recipe.tool)])]
          .filter((field) => !isDeepStrictEqual(tool[field], recipe.tool[field]))
          .sort();
        if (fields.length > 0)
          differences.push(
            `${fixture}: tool ${name}, recipe ${recipe.recipeId}/${recipe.name}: ${fields.join(", ")}`,
          );
      }
    }
  }

  // Then: copied tools agree in all fields, including extra fields and nested values.
  expect(differences, differences.join("\n")).toEqual([]);
});
