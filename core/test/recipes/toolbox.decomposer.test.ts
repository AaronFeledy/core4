import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest, type RecipeOptionValue } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { toolboxDecomposer } from "../../src/recipes/builtin/toolbox/decomposer.ts";
import { TOOLBOX_IMAGE } from "../../src/recipes/builtin/toolbox/image.ts";
import { toolboxRecipeSource, toolboxRecipeYaml } from "../../src/recipes/builtin/toolbox/manifest.ts";
import {
  TOOLBOX_CONTENT_DIGEST,
  toolboxDefaults,
  toolboxProducer,
  toolboxSnapshot,
} from "../../src/recipes/builtin/toolbox/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...toolboxDefaults };
const validInput: RecipeDecomposeInput = { producer: toolboxProducer, options: defaults, secrets: {} };
const decomposer = toolboxDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: toolboxProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: toolboxRecipeSource, content: toolboxRecipeYaml })),
);

describe("toolbox decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "toolbox",
        factory: toolboxDecomposer,
        producer: toolboxProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { database: "postgres" } },
        missingRecipeInput: { ...validInput, producer: { ...toolboxProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment for the recipe's only option set", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "toolbox",
      version: "0.1.0",
      producer: toolboxProducer,
      options: {},
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        toolbox: { type: "lando", primary: true, image: TOOLBOX_IMAGE, command: "sleep infinity" },
      },
    });
    expect(result.fragment.services.toolbox.image).toBe(TOOLBOX_IMAGE);
    expect<unknown>(result.fragment).toEqual({
      runtime: 4,
      recipe: result.provenance,
      ...authoringOf(defaults),
    });
  });

  test("accepts the app-name answer the translator forwards and omits it from provenance", () => {
    const result = decompose({ name: "probe" });
    expect(result.provenance.options).toEqual({});
    expect(authoringOf({ name: "probe" })).toEqual(authoringOf(defaults));
  });

  test.each([{ celery: true }, { database: "mysql" }, { php: "8.3" }])(
    "rejects an undeclared option key when input is %j",
    (options) => {
      const failure = Effect.runSync(
        Effect.either(decomposer.decompose({ producer: toolboxProducer, options, secrets: {} })),
      );
      expect(Either.isLeft(failure)).toBe(true);
      if (Either.isLeft(failure)) {
        expect(failure.left.reason).toBe("option-type");
        expect(failure.left.path).toBe(`options.${Object.keys(options)[0] ?? ""}`);
        expect(failure.left.remediation).toContain("declares no options");
      }
    },
  );

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(TOOLBOX_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(toolboxSnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot", () => {
    expect(Either.getOrThrow(renderRecipeSnapshot(toolboxSnapshot, defaults))).toEqual(authoringOf(defaults));
  });
});
