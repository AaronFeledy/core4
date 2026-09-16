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
import { hugoDecomposer } from "../../src/recipes/builtin/hugo/decomposer.ts";
import { hugoRecipeSource, hugoRecipeYaml } from "../../src/recipes/builtin/hugo/manifest.ts";
import {
  HUGO_CONTENT_DIGEST,
  hugoDefaults,
  hugoProducer,
  hugoSnapshot,
} from "../../src/recipes/builtin/hugo/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...hugoDefaults };
const validInput: RecipeDecomposeInput = { producer: hugoProducer, options: defaults, secrets: {} };
const decomposer = hugoDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: hugoProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: hugoRecipeSource, content: hugoRecipeYaml })),
);

describe("hugo decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "hugo",
        factory: hugoDecomposer,
        producer: hugoProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { database: "postgres" } },
        missingRecipeInput: { ...validInput, producer: { ...hugoProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment for the recipe's only option set", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "hugo",
      version: "0.1.0",
      producer: hugoProducer,
      options: {},
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        builder: {
          type: "node:lts",
          command: "npx hugo server --bind 0.0.0.0 --port 1313",
          port: 1313,
        },
        web: {
          type: "static:nginx",
          appMount: { target: "/app" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
      },
      tooling: {
        hugo: {
          service: "builder",
          description: "Run the Hugo CLI inside the builder service.",
          cmds: ["npx hugo"],
        },
        npm: { service: "builder", description: "Run npm inside the builder service.", cmds: ["npm"] },
      },
    });
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
        Effect.either(decomposer.decompose({ producer: hugoProducer, options, secrets: {} })),
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
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(HUGO_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(hugoSnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot", () => {
    expect(Either.getOrThrow(renderRecipeSnapshot(hugoSnapshot, defaults))).toEqual(authoringOf(defaults));
  });
});
