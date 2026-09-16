import { expect, test } from "bun:test";
import { Either } from "effect";
import type { ExpressionNode } from "../../src/expressions/ast.ts";
import {
  SNAPSHOT_HELPER_ALLOWLIST,
  collectSnapshotTemplateViolations,
  renderRecipeSnapshot,
  validateSnapshotTemplate,
} from "../../src/recipes/snapshot-template.ts";
import type { RecipeSnapshot } from "../../src/schema/recipe-snapshot.ts";

const snapshot = (expression: ExpressionNode): RecipeSnapshot => ({
  identity: {
    sourceKind: "bundled",
    packageName: "recipes",
    recipeId: "php",
    manifestVersion: "1.0.0",
    contentDigest: `sha256:${"a".repeat(64)}`,
  },
  optionTypes: {},
  defaults: { php: "8.2" },
  template: { expression },
  assets: [],
});
test("allowlist has exactly 47 entries and excludes forbidden IO and decoder helpers", () => {
  expect(SNAPSHOT_HELPER_ALLOWLIST.size).toBe(47);
  for (const name of [
    "load",
    "import",
    "text",
    "bytes",
    "hash",
    "which",
    "glob",
    "fs",
    "fs.read",
    "yaml",
    "fromYaml",
    "fromToml",
    "json5",
    "fromJson5",
    "jsonc",
    "fromJsonc",
    "jsonl",
    "fromJsonl",
  ])
    expect(SNAPSHOT_HELPER_ALLOWLIST.has(name)).toBe(false);
});
test("a non-options path head is template-scope", () => {
  expect(collectSnapshotTemplateViolations({ kind: "Path", head: "recipe", segments: [] })[0]?.reason).toBe(
    "template-scope",
  );
});
test("load is helper-forbidden", () => {
  const result = validateSnapshotTemplate("php", { expression: { kind: "Call", callee: "load", args: [] } });
  expect(Either.isLeft(result) && result.left.reason).toBe("helper-forbidden");
});
test("forbidden helper inside a dynamic path segment is caught", () => {
  expect(
    collectSnapshotTemplateViolations({
      kind: "Path",
      head: "options",
      segments: [{ type: "dynamic", expr: { kind: "Call", callee: "load", args: [] } }],
    })[0]?.reason,
  ).toBe("helper-forbidden");
});
test("over-deep template is depth-exceeded", () => {
  let node: ExpressionNode = { kind: "Literal", value: 1 };
  for (let i = 0; i < 33; i++) node = { kind: "ArrayLiteral", elements: [node] };
  expect(collectSnapshotTemplateViolations(node)[0]?.reason).toBe("depth-exceeded");
});
test("rendered literal {{ recipe.php }} is not re-evaluated", () => {
  expect(
    Either.getOrThrow(renderRecipeSnapshot(snapshot({ kind: "Literal", value: "{{ recipe.php }}" }), {})),
  ).toBe("{{ recipe.php }}");
});
test("options override snapshot defaults", () => {
  expect(
    Either.getOrThrow(
      renderRecipeSnapshot(
        snapshot({ kind: "Path", head: "options", segments: [{ type: "prop", name: "php" }] }),
        { php: "8.4" },
      ),
    ),
  ).toBe("8.4");
});
test("oversized inputs fail the pre-evaluation budget", () => {
  const result = renderRecipeSnapshot(snapshot({ kind: "Literal", value: "x".repeat(1_048_577) }), {});
  expect(Either.isLeft(result) && result.left.reason).toBe("budget-exceeded");
});
test("helper output observes collection budgets", () => {
  const result = renderRecipeSnapshot(
    snapshot({
      kind: "Call",
      callee: "range",
      args: [
        { kind: "Literal", value: 0 },
        { kind: "Literal", value: 10_001 },
      ],
    }),
    {},
  );
  expect(Either.isLeft(result) && result.left.reason).toBe("budget-exceeded");
});
test("walks Access, Conditional, ObjectLiteral, ArrayLiteral and static segments", () => {
  const node: ExpressionNode = {
    kind: "Conditional",
    test: { kind: "Literal", value: true },
    consequent: {
      kind: "ObjectLiteral",
      entries: [
        {
          key: "x",
          value: {
            kind: "ArrayLiteral",
            elements: [
              {
                kind: "Access",
                target: { kind: "Literal", value: "x" },
                segments: [
                  { type: "prop", name: "x" },
                  { type: "index", index: 0 },
                  { type: "key", key: "x" },
                  { type: "dynamic", expr: { kind: "Path", head: "env", segments: [] } },
                ],
              },
            ],
          },
        },
      ],
    },
    alternate: { kind: "Call", callee: "load", args: [] },
  };
  expect(collectSnapshotTemplateViolations(node).map((v) => v.reason)).toEqual([
    "template-scope",
    "helper-forbidden",
  ]);
});
