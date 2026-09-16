import { describe, expect, test } from "bun:test";
import { getAtPath } from "@lando/engine/config-write/dot-path";
import { renderRecipeSnapshot, sameRecipeVersion, validateMigrationChain } from "@lando/sdk/recipes";
import { RecipeMigration, RecipeSnapshot } from "@lando/sdk/schema";
import { Either, Schema } from "effect";
import {
  customizedOptionLandofile,
  makeMigrationFixture,
  managedLandofile,
  parseMigrationLandofile,
  renamedServiceLandofile,
  takenOverLandofile,
} from "./fixtures/recipe-migrations.ts";

describe("recipe migration fixture consistency", () => {
  test("accepts the complete chain when all coordinates and snapshots agree", () => {
    // Given
    const { target, migrations, snapshots } = makeMigrationFixture();
    // When
    const result = validateMigrationChain(target.identity, migrations);
    // Then
    expect(Either.isRight(result)).toBe(true);
    expect(snapshots.every(Schema.is(RecipeSnapshot))).toBe(true);
    expect(migrations.every(Schema.is(RecipeMigration))).toBe(true);
    expect(new Set(snapshots.map((snapshot) => snapshot.identity.contentDigest)).size).toBe(3);
    expect(migrations[0].toSnapshot).toEqual(migrations[1].fromSnapshot);
    expect(new Set(migrations.flatMap((edge) => edge.hunks.map((hunk) => hunk.kind)))).toEqual(
      new Set(["option-default", "add", "remove", "rename", "replace"]),
    );
    for (const edge of migrations) {
      expect(sameRecipeVersion(edge.from, edge.fromSnapshot.identity)).toBe(true);
      expect(sameRecipeVersion(edge.to, edge.toSnapshot.identity)).toBe(true);
    }
  });

  for (const [index, edge] of makeMigrationFixture().migrations.entries()) {
    for (const hunk of edge.hunks) {
      test(`describes the rendered diff when edge ${index + 1} applies ${hunk.kind} at ${hunk.path}`, () => {
        // Given: one option set is supplied to both endpoint renders.
        const options = { ...edge.fromSnapshot.defaults };
        // When
        const before = renderRecipeSnapshot(edge.fromSnapshot, options);
        const after = renderRecipeSnapshot(edge.toSnapshot, options);
        // Then: narrowing also makes a render failure fail this test immediately.
        if (Either.isLeft(before)) throw before.left;
        if (Either.isLeft(after)) throw after.left;
        switch (hunk.kind) {
          case "option-default":
            expect(getAtPath({ recipe: { options: edge.fromSnapshot.defaults } }, hunk.path)).toEqual(
              hunk.old,
            );
            expect(getAtPath({ recipe: { options: edge.toSnapshot.defaults } }, hunk.path)).toEqual(hunk.new);
            break;
          case "add":
            expect(getAtPath(before.right, hunk.path)).toBeUndefined();
            expect(getAtPath(after.right, hunk.path)).toEqual(hunk.new);
            break;
          case "remove":
            expect(getAtPath(before.right, hunk.path)).toEqual(hunk.old);
            expect(getAtPath(after.right, hunk.path)).toBeUndefined();
            break;
          case "replace":
            expect(getAtPath(before.right, hunk.path)).toEqual(hunk.old);
            expect(getAtPath(after.right, hunk.path)).toEqual(hunk.new);
            break;
          case "rename":
            expect(hunk.path).toBe(hunk.old);
            expect(getAtPath(before.right, hunk.old)).toBeDefined();
            expect(getAtPath(before.right, hunk.new)).toBeUndefined();
            expect(getAtPath(after.right, hunk.old)).toBeUndefined();
            expect(getAtPath(after.right, hunk.new)).toEqual(getAtPath(before.right, hunk.old));
            break;
          default:
            hunk satisfies never;
        }
      });
    }
  }

  test.each(["snapshot-mismatch", "identity-drift"] as const)(
    "rejects the malformed variant when it contains %s",
    (reason) => {
      // Given
      const { target, malformed } = makeMigrationFixture();
      // When
      const result = validateMigrationChain(target.identity, malformed[reason]);
      // Then
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isRight(result)) throw new Error("Malformed fixture was accepted");
      expect(result.left.reason).toBe(reason);
    },
  );

  test("matches the initial snapshot when the managed YAML is parsed", () => {
    // Given
    const { snapshots } = makeMigrationFixture();
    const { document, provenance } = parseMigrationLandofile(managedLandofile());
    // When
    const rendered = renderRecipeSnapshot(snapshots[0], provenance.options);
    // Then
    if (Either.isLeft(rendered)) throw rendered.left;
    const { name: _name, recipe: _recipe, ...authoring } = document;
    expect(rendered.right).toEqual(authoring);
    expect(provenance.producer).toEqual(snapshots[0].identity);
  });

  test.each([
    [takenOverLandofile, "services.appserver.webroot", "/custom"],
    [customizedOptionLandofile, "recipe.options.php", "8.4"],
    [renamedServiceLandofile, "recipe.services.appserver", "web"],
  ] as const)("preserves the distinguishing input when parsing %p", (text, path, value) => {
    // Given
    const yaml = text();
    // When
    const { document } = parseMigrationLandofile(yaml);
    // Then
    expect(getAtPath(document, path)).toEqual(value);
  });
});
