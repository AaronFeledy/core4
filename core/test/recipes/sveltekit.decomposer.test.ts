import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput, RecipeOptionValue } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
const {
  decomposer: sveltekitDecomposer,
  defaults: sveltekitDefaults,
  producer: sveltekitProducer,
  snapshot: sveltekitSnapshot,
  contentDigest: SVELTEKIT_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("sveltekit");

const defaults = { ...sveltekitDefaults };
const alternatives = { node: "22", adapter: "auto", database: "postgres" };
const withDatabase = { ...defaults, database: "mariadb" };
const validInput: RecipeDecomposeInput = { producer: sveltekitProducer, options: defaults, secrets: {} };
const decomposer = sveltekitDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: sveltekitProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

describe("sveltekit decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "sveltekit",
        factory: sveltekitDecomposer,
        producer: sveltekitProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, adapter: 22 } },
        missingRecipeInput: { ...validInput, producer: { ...sveltekitProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "sveltekit",
      version: "0.1.0",
      producer: sveltekitProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        web: {
          type: "node:{{ recipe.node }}",
          port: 5173,
          environment: { SVELTEKIT_ADAPTER: "{{ recipe.adapter }}" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
      },
      tooling: {
        svelte: {
          service: "web",
          description: "Run the Svelte CLI inside the web service.",
          cmds: ["npx svelte-kit"],
        },
        npm: { service: "web", description: "Run npm inside the web service.", cmds: ["npm"] },
      },
    });
    expect<unknown>(result.fragment).toEqual({
      runtime: 4,
      recipe: result.provenance,
      ...authoringOf(defaults),
    });
  });

  test("adds the database service and dependency when a database is selected", () => {
    const authoring = Schema.decodeUnknownSync(
      Schema.Struct({ services: Schema.Record(Schema.String, Schema.Unknown) }),
    )(authoringOf(withDatabase));
    expect(Object.keys(authoring.services)).toEqual(["web", "database"]);
    expect<unknown>(authoring.services.database).toEqual({ type: "{{ recipe.database }}" });
    const web = Schema.decodeUnknownSync(Schema.Struct({ dependsOn: Schema.optionalKey(Schema.Unknown) }))(
      authoring.services.web,
    );
    expect<unknown>(web.dependsOn).toEqual(["database"]);
  });

  test("preserves authoring data when only Node and adapter tokens vary", () => {
    expect(authoringOf({ ...defaults, node: "22", adapter: "auto" })).toEqual(authoringOf(defaults));
  });

  test("tolerates the app-name answer the translator forwards alongside declared options", () => {
    const result = decompose({ ...defaults, name: "probe" });
    expect(result.provenance.options).toEqual(defaults);
    expect(authoringOf({ ...defaults, name: "probe" })).toEqual(authoringOf(defaults));
  });

  test.each([
    { options: { ...defaults, node: 22 }, path: "options.node" },
    { options: { ...defaults, node: "18" }, path: "options.node" },
    { options: { ...defaults, adapter: "vercel" }, path: "options.adapter" },
    { options: { ...defaults, database: "mysql" }, path: "options.database" },
    { options: { ...defaults, database: true }, path: "options.database" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.result(decomposer.decompose({ producer: sveltekitProducer, options, secrets: {} })),
    );
    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) {
      expect(failure.failure.reason).toBe("option-type");
      expect(failure.failure.path).toBe(path);
      expect(failure.failure.remediation).toBeString();
    }
  });

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", async () => {
    expect(await recompiledBundledDigest(manifest)).toBe(SVELTEKIT_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(sveltekitSnapshot);
    expect(sveltekitSnapshot.identity.contentDigest).toBe(SVELTEKIT_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives, withDatabase])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Result.getOrThrow(renderRecipeSnapshot(sveltekitSnapshot, options))).toEqual(
        authoringOf(options),
      );
    },
  );
});
