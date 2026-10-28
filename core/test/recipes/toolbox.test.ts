import { describe, expect, test } from "bun:test";
import { RecipeManifest } from "@lando/sdk/schema";
import { Schema } from "effect";
import { TOOLBOX_IMAGE } from "../../src/recipes/builtin/toolbox/image.ts";
import { source } from "../../src/recipes/builtin/toolbox/source.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
import { decomposeBuiltinRecipe } from "../_support/recipe-output.ts";

const recipe = bundledRecipe("toolbox");
describe("toolbox canonical recipe", () => {
  test("generated artifact matches its sole author source", async () => {
    expect(recipe.authoredSource).toEqual(source);
    expect(await recompiledBundledDigest(recipe.manifest)).toBe(recipe.producer.contentDigest);
    expect(Schema.decodeUnknownSync(RecipeManifest)(recipe.manifest).id).toBe("toolbox");
    expect(recipe.manifest.prompts).toEqual([]);
  });
  test("renders exactly one lando service with a version-pinned image", () => {
    const { fragment } = decomposeBuiltinRecipe("toolbox");
    expect(fragment).toMatchObject({ services: { toolbox: { type: "lando", image: TOOLBOX_IMAGE } } });
    expect(Object.keys(Reflect.get(Object(fragment), "services"))).toEqual(["toolbox"]);
    expect(TOOLBOX_IMAGE).toMatch(/:[0-9][A-Za-z0-9_.-]*$/u);
  });
});
