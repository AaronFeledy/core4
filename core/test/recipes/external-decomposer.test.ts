import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { AbsolutePath, RecipeDecomposeResult } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { makeCompiledRecipeDecomposer } from "../../src/recipes/compiled-decomposer.ts";

const source = {
  id: "external",
  title: "External",
  description: "External fixture",
  version: "1.0.0",
  options: { image: { type: { kind: "string" }, default: "alpine:3.21" } },
  config: { runtime: 4, services: { app: { type: "lando", image: "{{ recipe.image }}" } } },
} as const;
const context = { sourceKind: "local", packageName: "@test/external", assets: [] } as const;
const manifestWithSnapshot = () => Result.getOrThrow(compileRecipeSource(source, context));

test("external factory satisfies the SDK decomposer contract", async () => {
  // Given
  const manifest = manifestWithSnapshot();
  const producer = manifest.snapshot.identity;
  const validInput = { producer, options: { image: "alpine:3.21" }, secrets: {} };
  const factory = makeCompiledRecipeDecomposer(manifest, {
    source: "/recipe.yml",
    appRoot: AbsolutePath.make("/app"),
  });
  // When / Then
  await Effect.runPromise(
    runRecipeDecomposerContractSuite({
      factory,
      producer,
      validInput,
      typedOptionFailureInput: { ...validInput, options: { image: false } },
      missingRecipeInput: { ...validInput, producer: { ...producer, recipeId: "wrong-family" } },
    }),
  );
});

test.each(["sourceKind", "packageName", "recipeId", "manifestVersion", "contentDigest"] as const)(
  "external decomposer rejects a mismatched requested producer %s",
  async (coordinate) => {
    // Given
    const manifest = manifestWithSnapshot();
    const factory = makeCompiledRecipeDecomposer(manifest, {
      source: "/recipe.yml",
      appRoot: AbsolutePath.make("/app"),
    });
    const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
    const producer = {
      ...decomposer.producer,
      ...(coordinate === "sourceKind" ? { sourceKind: "plugin" as const } : {}),
      ...(coordinate === "packageName" ? { packageName: "@other/external" } : {}),
      ...(coordinate === "recipeId" ? { recipeId: "wrong-family" } : {}),
      ...(coordinate === "manifestVersion" ? { manifestVersion: "2.0.0" } : {}),
      ...(coordinate === "contentDigest" ? { contentDigest: `sha256:${"f".repeat(64)}` } : {}),
    };
    // When
    const result = await Effect.runPromise(
      Effect.result(decomposer.decompose({ producer, options: {}, secrets: {} })),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "RecipeDecomposeError", reason: "missing-recipe" },
    });
  },
);

test("external decomposer returns a complete validated fragment with default provenance", async () => {
  // Given
  const manifest = manifestWithSnapshot();
  const factory = makeCompiledRecipeDecomposer(manifest, {
    source: "/recipes/external/recipe.yml",
    appRoot: AbsolutePath.make("/apps/external"),
  });
  const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
  // When
  const result = await Effect.runPromise(
    decomposer.decompose({ producer: decomposer.producer, options: { name: "metadata" }, secrets: {} }),
  );
  // Then
  expect(Schema.is(RecipeDecomposeResult)(result)).toBe(true);
  expect(result.fragment).toMatchObject({ runtime: 4, services: { app: { image: "{{ recipe.image }}" } } });
  expect(result.provenance.options).toEqual({ image: "alpine:3.21" });
});

test("compiler rejects a file without observed raw asset evidence", () => {
  const result = compileRecipeSource({ ...source, files: [{ src: "tampered", dest: "tampered" }] }, context);
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "asset-invalid" } });
});
test("compiler rejects a forbidden config helper before decomposition", () => {
  const result = compileRecipeSource(
    { ...source, config: { services: { app: { image: '{{ fetch("https://example.test") }}' } } } },
    context,
  );
  expect(result._tag).toBe("Failure");
});
for (const coordinate of ["recipeId", "manifestVersion", "sourceKind"] as const) {
  test(`compiler rejects author-supplied snapshot ${coordinate} claims`, () => {
    const result = compileRecipeSource(
      { ...source, snapshot: { identity: { [coordinate]: "foreign" } } },
      context,
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "source-invalid" } });
  });
}

for (const options of [{ unknown: "value" }, { image: false }]) {
  test(`external decomposer rejects invalid declared option input ${Object.keys(options)[0]}`, async () => {
    // Given
    const factory = makeCompiledRecipeDecomposer(manifestWithSnapshot(), {
      source: "/recipe.yml",
      appRoot: AbsolutePath.make("/app"),
    });
    const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
    // When
    const result = await Effect.runPromise(
      Effect.result(decomposer.decompose({ producer: decomposer.producer, options, secrets: {} })),
    );
    // Then
    expect(result._tag).toBe("Failure");
  });
}
