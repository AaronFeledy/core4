import { describe, expect, test } from "bun:test";
import { renderRecipeSnapshot } from "@lando/sdk/recipes";
import { RecipeSnapshot } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { recipeSnapshotYaml } from "../../src/recipes/builtin/snapshot-yaml.ts";
import { BUILTIN_RECIPE_SNAPSHOTS } from "../../src/recipes/builtin/snapshots.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";
import { bundledRecipe } from "../_support/bundled-recipe.ts";

const lampSnapshot = bundledRecipe("lamp").snapshot;
describe("recipe snapshot transport", () => {
  test.each([...BUILTIN_RECIPE_SNAPSHOTS])(
    "preserves %s compiled data and behavior across inert JSON transport",
    (_, snapshot) => {
      const transported = Schema.decodeUnknownSync(RecipeSnapshot)(JSON.parse(JSON.stringify(snapshot)));
      expect(transported).toEqual(snapshot);
      expect(Result.getOrThrow(renderRecipeSnapshot(transported, snapshot.defaults))).toEqual(
        Result.getOrThrow(renderRecipeSnapshot(snapshot, snapshot.defaults)),
      );
    },
  );
  test.each([
    { nested: [{ children: [{ empty: {}, values: ["8.3", "2", "{{ recipe.php }}"] }], next: true }] },
    { emptyArray: [], emptyObject: {}, after: "preserved" },
    { numbers: [0, -0, 42, -1.25, 1e-7, 1e21, Number.MIN_VALUE, Number.MAX_VALUE] },
    { scalars: [true, false, null, "true", "null", "~", "[]", "{}", "a,b", "#hash", "back\\slash"] },
    {
      items: [
        { first: [], second: {} },
        { first: { nested: true }, second: "value" },
      ],
    },
    { "123": "numeric key", "-key": "hyphen key" },
  ])("round-trips historical YAML-compatible values: %j", (testData) => {
    const snapshot = { ...lampSnapshot, testData };
    const parsed = Effect.runSync(
      parseRecipeYaml({ source: "recipe.yml", content: recipeSnapshotYaml(snapshot) }),
    );
    expect(parsed).toEqual({ snapshot });
  });
  test.each([
    [{ "bad.key": true }, /Invalid.*key/],
    [{ ["__proto__"]: true }, /Invalid.*key/],
    ['embedded "quote', /double quotes/],
    ["embedded #comment", /whitespace followed by #/],
    ["embedded\ttab", /tabs/],
    ["embedded\nline", /line breaks/],
    [Number.POSITIVE_INFINITY, /finite/],
    [[{}], /empty maps/],
    [[[1]], /array directly inside a sequence/],
    [[{ "123": true }], /first key/],
  ] as const)("rejects unrepresentable historical YAML input: %j", (testData, message) => {
    const snapshot = { ...lampSnapshot, testData };
    expect(() => recipeSnapshotYaml(snapshot)).toThrow(message);
  });
  test("emits historical two-space block indentation in insertion order", () => {
    const yaml = recipeSnapshotYaml({ ...lampSnapshot, optionTypes: {}, defaults: { z: "2", a: true } });
    expect(yaml).toContain('  optionTypes:\n  defaults:\n    z: "2"\n    a: true\n');
  });
});
