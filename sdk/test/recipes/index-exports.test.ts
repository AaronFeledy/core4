import { expect, test } from "bun:test";
import * as recipes from "../../src/recipes/index.ts";

test("recipes exports every public helper", () => {
  expect(Object.keys(recipes).sort()).toEqual(
    [
      "SNAPSHOT_HELPER_ALLOWLIST",
      "SNAPSHOT_RENDER_BUDGET",
      "approvedSecretReferencesOnly",
      "canonicalJson",
      "computeRecipeContentDigest",
      "classifyHunk",
      "collectSnapshotTemplateViolations",
      "deriveHunkId",
      "deriveRecipeProducer",
      "fullRecipeMigratability",
      "isBareRecipeReference",
      "optionValueMatchesDescriptor",
      "recipeContentDigestProjection",
      "recipeFamilyKey",
      "recipeMigratability",
      "recipeVersionedKey",
      "renderRecipeSnapshot",
      "sameRecipeFamily",
      "sameRecipeVersion",
      "secretSinkFailure",
      "selectMigrationPath",
      "validateLandofileRecipeProvenance",
      "validateMigrationChain",
      "validateOptionValues",
      "validateRecipeSecretPrompts",
      "validateSnapshotTemplate",
    ].sort(),
  );
});
test("full migratability validates migration history", () => {
  const identity = {
    sourceKind: "bundled",
    packageName: "recipes",
    recipeId: "php",
    manifestVersion: "1.0.0",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const snapshot = {
    identity,
    optionTypes: {},
    defaults: {},
    assets: [],
    template: { expression: { kind: "Literal", value: "ok" } },
  } as const;
  expect(
    recipes.fullRecipeMigratability(
      {
        id: "php",
        version: "1.0.0",
        title: "PHP",
        description: "PHP",
        snapshot,
        migrations: [
          { from: identity, to: identity, fromSnapshot: snapshot, toSnapshot: snapshot, hunks: [] },
        ],
      },
      "bundled",
    ),
  ).toMatchObject({ status: "nonmigratable", reason: "reverse" });
});
