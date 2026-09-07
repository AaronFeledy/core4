import { expect, test } from "bun:test";
import { Either } from "effect";
import {
  optionValueMatchesDescriptor,
  recipeMigratability,
  validateOptionValues,
} from "../../src/recipes/option-types.ts";
import type { RecipeOptionType } from "../../src/schema/recipe-snapshot.ts";

test.each([
  [{ kind: "string", pattern: "^[a-z]+$", minLength: 2, maxLength: 3 }, "12", false],
  [{ kind: "string", pattern: "[" }, "ok", false],
  [{ kind: "number", min: 1, max: 3, integer: true }, 1.5, false],
  [{ kind: "boolean" }, true, true],
  [{ kind: "enum", values: ["a", "b"] }, "c", false],
  [{ kind: "array", items: { kind: "number" }, maxItems: 1 }, [1, 2], false],
  [{ kind: "optional", inner: { kind: "string" } }, undefined, true],
] satisfies ReadonlyArray<readonly [RecipeOptionType, unknown, boolean]>)(
  "descriptor %j matches %j: %j",
  (descriptor, value, expected) => {
    expect(optionValueMatchesDescriptor(descriptor, value)).toBe(expected);
  },
);
test("option descriptor rejection names the option in path", () => {
  const result = validateOptionValues({ php: { kind: "string" } }, {}, { php: 8 });
  expect(Either.isLeft(result) && [result.left.reason, result.left.path]).toEqual(["option-type", "php"]);
});
test("undeclared option is unsupported-option", () => {
  const result = validateOptionValues({}, {}, { php: 8 });
  expect(Either.isLeft(result) && [result.left.reason, result.left.path]).toEqual([
    "unsupported-option",
    "php",
  ]);
});
test("defaults merge under supplied options", () => {
  expect(
    Either.getOrThrow(validateOptionValues({ php: { kind: "string" } }, { php: "8.2" }, { php: "8.4" })),
  ).toEqual({ php: "8.4" });
});
test("missing required options are rejected", () => {
  expect(Either.isLeft(validateOptionValues({ php: { kind: "string" } }, {}, {}))).toBe(true);
});
test.each(["bundled", "plugin", "local"] as const)("missing snapshot for %s", (sourceKind) => {
  expect(
    recipeMigratability({ id: "php", version: "1.0.0", title: "PHP", description: "PHP" }, sourceKind),
  ).toEqual({
    status: "nonmigratable",
    reason: sourceKind === "local" ? "local-programmatic-without-snapshot" : "missing-snapshot",
  });
});
test("snapshot identity must match the manifest", () => {
  expect(
    recipeMigratability(
      {
        id: "php",
        version: "1.0.0",
        title: "PHP",
        description: "PHP",
        snapshot: {
          identity: {
            sourceKind: "bundled",
            packageName: "recipes",
            recipeId: "other",
            manifestVersion: "1.0.0",
            contentDigest: `sha256:${"a".repeat(64)}`,
          },
          optionTypes: {},
          defaults: {},
          template: { expression: { kind: "Literal", value: "ok" } },
          assets: [],
        },
      },
      "bundled",
    ),
  ).toEqual({ status: "nonmigratable", reason: "identity-mismatch" });
});
test("mistyped snapshot defaults are unsupported-option-type", () => {
  expect(
    recipeMigratability(
      {
        id: "php",
        version: "1.0.0",
        title: "PHP",
        description: "PHP",
        snapshot: {
          identity: {
            sourceKind: "bundled",
            packageName: "recipes",
            recipeId: "php",
            manifestVersion: "1.0.0",
            contentDigest: `sha256:${"a".repeat(64)}`,
          },
          optionTypes: { php: { kind: "number" } },
          defaults: { php: "not-a-number" },
          template: { expression: { kind: "Literal", value: "ok" } },
          assets: [],
        },
      },
      "bundled",
    ),
  ).toEqual({ status: "nonmigratable", reason: "unsupported-option-type" });
});
