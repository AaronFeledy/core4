import { describe, expect, test } from "bun:test";
import { compiledLandofileSource } from "@lando/landofile/serializer";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  fullRecipeMigratability,
  renderCompiledRecipeSnapshot,
  validateSnapshotTemplate,
} from "@lando/sdk/recipes";
import { AbsolutePath } from "@lando/sdk/schema";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
const {
  decomposer: nodeTsDecomposer,
  defaults: nodeTsDefaults,
  producer: nodeTsProducer,
  snapshot: nodeTsSnapshot,
  contentDigest: NODE_TS_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("node-ts");

const defaults = { ...nodeTsDefaults };
const validInput: RecipeDecomposeInput = { producer: nodeTsProducer, options: defaults, secrets: {} };
const decomposer = nodeTsDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: RecipeDecomposeInput["options"]) =>
  Effect.runSync(decomposer.decompose({ producer: nodeTsProducer, options, secrets: {} }));

const authoringOf = (options: RecipeDecomposeInput["options"]) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

describe("node-ts decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "node-ts",
        factory: nodeTsDecomposer,
        producer: nodeTsProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { node: "22" } },
        missingRecipeInput: { ...validInput, producer: { ...nodeTsProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact fragment and provenance when default options are supplied", () => {
    const result = decompose(defaults);
    const provenance = { id: "node-ts", version: "0.1.0", producer: nodeTsProducer, options: {} };
    expect(result.provenance).toEqual(provenance);
    expect(result.fragment).toEqual({
      runtime: 4,
      recipe: provenance,
      services: {
        web: {
          image: 'node:{{ default(env.LANDO_NODE_VERSION, "24") }}',
          environment: { NODE_ENV: '{{ default(env.NODE_ENV, "development") }}' },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
      },
    });
  });

  test("declares no recipe options or persisted defaults", () => {
    expect(nodeTsSnapshot.optionTypes).toEqual({});
    expect(nodeTsSnapshot.defaults).toEqual({});
  });

  test("accepts the app-name prompt without recording it as a recipe option", () => {
    const result = decompose({ name: "probe" });
    expect(result.provenance.options).toEqual({});
    expect(result.fragment).toEqual(decompose({}).fragment);
  });

  test("never generates programmatic Landofile assets or source in the replacement path", () => {
    const fragment = decompose(defaults).fragment;
    expect(nodeTsSnapshot.assets).toEqual([]);
    const serializedFragment = JSON.stringify(fragment);
    expect(serializedFragment).not.toContain(".lando.ts");
    expect(serializedFragment).not.toContain("export default");
    expect(serializedFragment).not.toContain("ctx.env");
    expect(Object.keys(fragment)).toEqual(["runtime", "recipe", "services"]);
  });

  test("has zero snapshot template violations when authoring expressions are inert literals", () => {
    expect(Result.isSuccess(validateSnapshotTemplate("node-ts", nodeTsSnapshot.template))).toBe(true);
  });

  test.each([
    { options: { node: "22" }, path: "options.node" },
    { options: { env: {} }, path: "options.env" },
  ])("rejects an undeclared option when input is %j", ({ options, path }) => {
    const input: RecipeDecomposeInput = { producer: nodeTsProducer, options: {}, secrets: {} };
    // Exercise malformed runtime input without asserting it has the SDK's valid option type.
    for (const [key, value] of Object.entries(options)) {
      Object.defineProperty(input.options, key, { value, enumerable: true });
    }
    const failure = Effect.runSync(Effect.result(decomposer.decompose(input)));
    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) {
      expect(failure.failure.reason).toBe("option-type");
      expect(failure.failure.path).toBe(path);
      expect(failure.failure.remediation).toBeString();
    }
  });

  test("publishes the canonical Landofile target used by the init pipeline", () => {
    expect(manifest.files).toEqual([]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", async () => {
    expect(await recompiledBundledDigest(manifest)).toBe(NODE_TS_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(nodeTsSnapshot);
    expect(nodeTsSnapshot.identity.contentDigest).toBe(NODE_TS_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(NODE_TS_CONTENT_DIGEST).toBe(nodeTsSnapshot.identity.contentDigest);
  });

  test("renders the same authoring data from the snapshot when options are empty", () => {
    expect(
      compiledLandofileSource(
        Result.getOrThrow(
          renderCompiledRecipeSnapshot(nodeTsSnapshot, {}, { appRoot: AbsolutePath.make("/"), env: {} }),
        ),
      ),
    ).toEqual(authoringOf(defaults));
  });
});
