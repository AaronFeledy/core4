import { expect, test } from "bun:test";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { toMergedValue } from "../src/legacy-merge.ts";
import { classifyRecipe, mapConfigOptions } from "../src/recipe-options.ts";

const mapRecipe = (content: string) => {
  const file = ".lando.yml";
  const document = Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
  const root = toMergedValue({
    document,
    sourceId: ConfigTranslateSourceId.make(file),
    layer: "canonical",
  });
  if (root?.kind !== "mapping") throw new Error("Expected a recipe mapping");
  const recipe = classifyRecipe(root.entries.get("recipe"));
  if (recipe?._tag !== "supported") throw new Error("Expected a supported recipe");
  return mapConfigOptions(recipe, root.entries.get("config"));
};

test.each(["drupal", "wordpress", "lamp", "lemp", "laravel", "symfony", "backdrop", "joomla"])(
  "uses PHP 8.4 when converting %s without a PHP override",
  (recipe) => {
    // Given a legacy recipe without a PHP selection.
    const content = `recipe: ${recipe}\n`;
    // When its options are mapped to the bundled v4 recipe.
    const result = mapRecipe(content);
    // Then conversion uses the published v4 default.
    expect(result.options.php).toBe("8.4");
  },
);

test.each(["wordpress", "lemp"])("preserves all published PHP choices when converting %s", (recipe) => {
  // Given every supported PHP version, including a non-default older version.
  for (const php of ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"]) {
    // When the explicit legacy selection is mapped.
    const result = mapRecipe(`recipe: ${recipe}\nconfig: {php: "${php}"}\n`);
    // Then it is accepted and retained, not replaced with the default.
    expect(result.invalid).toEqual([]);
    expect(result.options.php).toBe(php);
  }
});
