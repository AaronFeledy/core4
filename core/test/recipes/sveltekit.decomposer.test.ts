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
import { sveltekitDecomposer } from "../../src/recipes/builtin/sveltekit/decomposer.ts";
import { sveltekitRecipeSource, sveltekitRecipeYaml } from "../../src/recipes/builtin/sveltekit/manifest.ts";
import {
  SVELTEKIT_CONTENT_DIGEST,
  sveltekitDefaults,
  sveltekitProducer,
  sveltekitSnapshot,
} from "../../src/recipes/builtin/sveltekit/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...sveltekitDefaults };
const alternatives = { node: "22", adapter: "auto", database: "postgres" };
const withDatabase = { ...defaults, database: "mariadb" };
const validInput: RecipeDecomposeInput = { producer: sveltekitProducer, options: defaults, secrets: {} };
const decomposer = sveltekitDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: sveltekitProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: sveltekitRecipeSource, content: sveltekitRecipeYaml })),
);

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
      Schema.Struct({ services: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }),
    )(authoringOf(withDatabase));
    expect(Object.keys(authoring.services)).toEqual(["web", "database"]);
    expect<unknown>(authoring.services.database).toEqual({ type: "{{ recipe.database }}" });
    const web = Schema.decodeUnknownSync(Schema.Struct({ dependsOn: Schema.optional(Schema.Unknown) }))(
      authoring.services.web,
    );
    expect<unknown>(web.dependsOn).toEqual(["database"]);
  });

  test("preserves authoring data when only Node and adapter tokens vary", () => {
    expect(authoringOf({ ...defaults, node: "22", adapter: "auto" })).toEqual(authoringOf(defaults));
  });

  test("tolerates the app-name answer the translator forwards alongside declared options", () => {
    const result = decompose({ ...defaults, name: "probe" });
    expect(result.provenance.options).toEqual({ ...defaults, name: "probe" });
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
      Effect.either(decomposer.decompose({ producer: sveltekitProducer, options, secrets: {} })),
    );
    expect(Either.isLeft(failure)).toBe(true);
    if (Either.isLeft(failure)) {
      expect(failure.left.reason).toBe("option-type");
      expect(failure.left.path).toBe(path);
      expect(failure.left.remediation).toBeString();
    }
  });

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(
      SVELTEKIT_CONTENT_DIGEST,
    );
    expect(manifest.snapshot).toEqual(sveltekitSnapshot);
    expect(sveltekitSnapshot.identity.contentDigest).toBe(
      "sha256:f8a23c071d0f1b1528573a6514c9927ab5f2a64a286be3d5a7e58f9c5bfec469",
    );
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives, withDatabase])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(sveltekitSnapshot, options))).toEqual(
        authoringOf(options),
      );
    },
  );
});
