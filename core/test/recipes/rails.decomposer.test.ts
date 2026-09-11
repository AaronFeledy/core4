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
import { railsDecomposer } from "../../src/recipes/builtin/rails/decomposer.ts";
import { railsRecipeSource, railsRecipeYaml } from "../../src/recipes/builtin/rails/manifest.ts";
import { RAILS_GEMFILE } from "../../src/recipes/builtin/rails/scaffold.ts";
import {
  RAILS_CONTENT_DIGEST,
  railsDefaults,
  railsProducer,
  railsSnapshot,
} from "../../src/recipes/builtin/rails/snapshot.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...railsDefaults };
const validInput: RecipeDecomposeInput = { producer: railsProducer, options: defaults, secrets: {} };
const decomposer = railsDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: railsProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: railsRecipeSource, content: railsRecipeYaml })),
);

describe("rails decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "rails",
        factory: railsDecomposer,
        producer: railsProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ruby: "3.3" } },
        missingRecipeInput: { ...validInput, producer: { ...railsProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment for the recipe's only option set", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "rails",
      version: "0.1.0",
      producer: railsProducer,
      options: {},
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        web: {
          type: "ruby:3.3",
          framework: "rails",
          port: 3000,
          build: {
            artifact: [
              "apt-get update && apt-get install -y --no-install-recommends build-essential",
              "gem install rails --no-document",
            ],
          },
          dependsOn: ["database", "cache"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "postgres" },
        cache: { type: "redis" },
      },
      tooling: {
        rails: { service: "web", description: "Run the Rails CLI inside the web service.", cmds: ["rails"] },
        bundle: { service: "web", description: "Run Bundler inside the web service.", cmds: ["bundle"] },
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

  test.each([{ ruby: "3.3" }, { database: "mysql" }, { composer: false }])(
    "rejects an undeclared option key when input is %j",
    (options) => {
      const failure = Effect.runSync(
        Effect.either(decomposer.decompose({ producer: railsProducer, options, secrets: {} })),
      );
      expect(Either.isLeft(failure)).toBe(true);
      if (Either.isLeft(failure)) {
        expect(failure.left.reason).toBe("option-type");
        expect(failure.left.path).toBe(`options.${Object.keys(options)[0] ?? ""}`);
        expect(failure.left.remediation).toContain("declares no options");
      }
    },
  );

  test("publishes the Gemfile auxiliary asset alongside declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
      { src: "assets/Gemfile", dest: "Gemfile", template: false },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([
      {
        dest: "Gemfile",
        digest: `sha256:${new Bun.CryptoHasher("sha256").update(RAILS_GEMFILE, "utf8").digest("hex")}`,
        template: false,
      },
    ]);
  });

  test("hashes the Gemfile source the bundled content source supplies", async () => {
    expect(await bundledRecipeContentSource("rails")({ src: "templates/Gemfile", dest: "Gemfile" })).toBe(
      RAILS_GEMFILE,
    );
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(RAILS_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(railsSnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot", () => {
    expect(Either.getOrThrow(renderRecipeSnapshot(railsSnapshot, defaults))).toEqual(authoringOf(defaults));
  });
});
