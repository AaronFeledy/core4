import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { mergeLandofiles } from "@lando/sdk/landofile";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput, RecipeOptionValue } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { RAILS_GEMFILE } from "../../src/recipes/builtin/rails/scaffold.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
const {
  decomposer: railsDecomposer,
  defaults: railsDefaults,
  producer: railsProducer,
  snapshot: railsSnapshot,
  contentDigest: RAILS_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("rails");
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";

const defaults = { ...railsDefaults };
const validInput: RecipeDecomposeInput = { producer: railsProducer, options: defaults, secrets: {} };
const decomposer = railsDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: railsProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

describe("rails decomposition", () => {
  test("preserves authored settings when a local layer overrides the scaffold", () => {
    // Given the recipe's materialized defaults and distinct local values.
    const local = {
      services: {
        web: {
          webroot: "static",
          port: 3100,
          environment: { RAILS_ENV: "test", RAILS_LOG_TO_STDOUT: "false" },
        },
      },
    };
    // When the local Landofile layer is applied.
    const merged = mergeLandofiles([authoringOf(defaults), local]);
    // Then the author's values win without losing the framework identity.
    expect(merged).toMatchObject({ services: { web: { framework: "rails", ...local.services.web } } });
  });

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
          webroot: "public",
          port: 3000,
          environment: {
            RAILS_ENV: "development",
            RAILS_LOG_TO_STDOUT: "true",
            DATABASE_URL:
              "postgresql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}",
            REDIS_URL: "redis://cache:6379",
          },
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
        rake: { service: "web", description: "Run Rake inside the web service.", cmds: ["rake"] },
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
        Effect.result(decomposer.decompose({ producer: railsProducer, options, secrets: {} })),
      );
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure.reason).toBe("option-type");
        expect(failure.failure.path).toBe(`options.${Object.keys(options)[0] ?? ""}`);
        expect(failure.failure.remediation).toContain("declares no options");
      }
    },
  );

  test("publishes the Gemfile auxiliary asset alongside declared files and postInit", () => {
    expect(manifest.files).toEqual([{ src: "assets/Gemfile", dest: "Gemfile", template: false }]);
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

  test("publishes a self-consistent migratable snapshot with a matching content identity", async () => {
    expect(await recompiledBundledDigest(manifest)).toBe(RAILS_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(railsSnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot", () => {
    expect(Result.getOrThrow(renderRecipeSnapshot(railsSnapshot, defaults))).toEqual(authoringOf(defaults));
  });
});
