import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
  validateSnapshotTemplate,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { nodeTsDecomposer } from "../../src/recipes/builtin/node-ts/decomposer.ts";
import { nodeTsRecipeYaml } from "../../src/recipes/builtin/node-ts/manifest.ts";
import {
  NODE_TS_CONTENT_DIGEST,
  nodeTsDefaults,
  nodeTsProducer,
  nodeTsSnapshot,
} from "../../src/recipes/builtin/node-ts/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...nodeTsDefaults };
const validInput: RecipeDecomposeInput = { producer: nodeTsProducer, options: defaults, secrets: {} };
const decomposer = nodeTsDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: RecipeDecomposeInput["options"]) =>
  Effect.runSync(decomposer.decompose({ producer: nodeTsProducer, options, secrets: {} }));

const authoringOf = (options: RecipeDecomposeInput["options"]) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: "node-ts/recipe.yml", content: nodeTsRecipeYaml })),
);

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
          image: "node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}",
          environment: { NODE_ENV: "{{ default(env.NODE_ENV, 'development') }}" },
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
    expect(Either.isRight(validateSnapshotTemplate("node-ts", nodeTsSnapshot.template))).toBe(true);
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
    const failure = Effect.runSync(Effect.either(decomposer.decompose(input)));
    expect(Either.isLeft(failure)).toBe(true);
    if (Either.isLeft(failure)) {
      expect(failure.left.reason).toBe("option-type");
      expect(failure.left.path).toBe(path);
      expect(failure.left.remediation).toBeString();
    }
  });

  test("publishes an empty auxiliary inventory while retaining the bound renderer manifest", () => {
    expect(manifest.files).toEqual([{ src: "templates/.lando.ts.tmpl", dest: ".lando.ts", template: true }]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(NODE_TS_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(nodeTsSnapshot);
    expect(nodeTsSnapshot.identity.contentDigest).toBe(NODE_TS_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(NODE_TS_CONTENT_DIGEST).toBe(
      "sha256:df6b7b0ed7834bde8d310b856db4cd798ef8a1d84cea578e3e0ceef2ecd40ec5",
    );
  });

  test("renders the same authoring data from the snapshot when options are empty", () => {
    expect(Either.getOrThrow(renderRecipeSnapshot(nodeTsSnapshot, {}))).toEqual(authoringOf(defaults));
  });
});
