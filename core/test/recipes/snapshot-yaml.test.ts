import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { backdropSnapshot, backdropSnapshotYaml } from "../../src/recipes/builtin/backdrop/snapshot.ts";
import { drupalCmsSnapshot, drupalCmsSnapshotYaml } from "../../src/recipes/builtin/drupal-cms/snapshot.ts";
import { drupalSnapshot, drupalSnapshotYaml } from "../../src/recipes/builtin/drupal/snapshot.ts";
import { joomlaSnapshot, joomlaSnapshotYaml } from "../../src/recipes/builtin/joomla/snapshot.ts";
import { lampSnapshot, lampSnapshotYaml } from "../../src/recipes/builtin/lamp/snapshot.ts";
import { laravelSnapshot, laravelSnapshotYaml } from "../../src/recipes/builtin/laravel/snapshot.ts";
import { lempSnapshot, lempSnapshotYaml } from "../../src/recipes/builtin/lemp/snapshot.ts";
import { recipeSnapshotYaml } from "../../src/recipes/builtin/snapshot-yaml.ts";
import { symfonySnapshot, symfonySnapshotYaml } from "../../src/recipes/builtin/symfony/snapshot.ts";
import { wordpressSnapshot, wordpressSnapshotYaml } from "../../src/recipes/builtin/wordpress/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

describe("recipe snapshot YAML", () => {
  test.each([
    ["lamp", lampSnapshot, lampSnapshotYaml],
    ["lemp", lempSnapshot, lempSnapshotYaml],
    ["wordpress", wordpressSnapshot, wordpressSnapshotYaml],
    ["laravel", laravelSnapshot, laravelSnapshotYaml],
    ["symfony", symfonySnapshot, symfonySnapshotYaml],
    ["drupal", drupalSnapshot, drupalSnapshotYaml],
    ["drupal-cms", drupalCmsSnapshot, drupalCmsSnapshotYaml],
    ["backdrop", backdropSnapshot, backdropSnapshotYaml],
    ["joomla", joomlaSnapshot, joomlaSnapshotYaml],
  ] as const)(
    "round-trips the published %s snapshot through the restricted parser",
    (_, snapshot, content) => {
      // Given the bundled snapshot's published YAML.
      // When core parses it without a general-purpose YAML library.
      const parsed = Effect.runSync(parseRecipeYaml({ source: "recipe.yml", content }));
      // Then every value retains its original type and content.
      expect(parsed).toEqual({ snapshot });
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
  ])("round-trips supported JSON values: %j", (testData) => {
    // Given a snapshot carrying the JSON value under test.
    const snapshot = { ...lampSnapshot, testData };
    // When the emitted YAML is parsed by core.
    const parsed = Effect.runSync(
      parseRecipeYaml({ source: "recipe.yml", content: recipeSnapshotYaml(snapshot) }),
    );
    // Then the parser preserves the complete value.
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
  ] as const)("rejects unrepresentable input: %j", (testData, message) => {
    // Given data outside the restricted parser's representable subset.
    const snapshot = { ...lampSnapshot, testData };
    // When emission is attempted, then it fails loudly instead of corrupting data.
    expect(() => recipeSnapshotYaml(snapshot)).toThrow(message);
  });

  test("emits two-space block indentation in insertion order", () => {
    // Given a minimal snapshot with deliberately ordered keys.
    const snapshot = { ...lampSnapshot, optionTypes: {}, defaults: { z: "2", a: true } };
    // When YAML is emitted.
    const yaml = recipeSnapshotYaml(snapshot);
    // Then empty maps and ordered scalars use the restricted block form.
    expect(yaml).toContain('  optionTypes:\n  defaults:\n    z: "2"\n    a: true\n');
  });
});
