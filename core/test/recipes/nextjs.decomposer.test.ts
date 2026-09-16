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
import { nextjsDecomposer } from "../../src/recipes/builtin/nextjs/decomposer.ts";
import { nextjsRecipeSource, nextjsRecipeYaml } from "../../src/recipes/builtin/nextjs/manifest.ts";
import {
  NEXTJS_CONTENT_DIGEST,
  nextjsDefaults,
  nextjsProducer,
  nextjsSnapshot,
} from "../../src/recipes/builtin/nextjs/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...nextjsDefaults };
const alternatives = { node: "22", database: "mariadb", auth: "clerk" };
const noDatabase = { ...defaults, database: "none" };
const validInput: RecipeDecomposeInput = { producer: nextjsProducer, options: defaults, secrets: {} };
const decomposer = nextjsDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: nextjsProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: nextjsRecipeSource, content: nextjsRecipeYaml })),
);

describe("nextjs decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "nextjs",
        factory: nextjsDecomposer,
        producer: nextjsProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, auth: 22 } },
        missingRecipeInput: { ...validInput, producer: { ...nextjsProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "nextjs",
      version: "0.1.0",
      producer: nextjsProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        web: {
          type: "node:{{ recipe.node }}",
          port: 3000,
          environment: { NEXTAUTH_PROVIDER: "{{ recipe.auth }}" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          dependsOn: ["database"],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        next: {
          service: "web",
          description: "Run the Next.js CLI inside the web service.",
          cmds: ["npx next"],
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

  test("drops the database service and dependency when the database is none", () => {
    const authoring = Schema.decodeUnknownSync(
      Schema.Struct({ services: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }),
    )(authoringOf(noDatabase));
    expect(Object.keys(authoring.services)).toEqual(["web"]);
    const web = Schema.decodeUnknownSync(Schema.Struct({ dependsOn: Schema.optional(Schema.Unknown) }))(
      authoring.services.web,
    );
    expect(web.dependsOn).toBeUndefined();
  });

  test("preserves authoring data when only Node and auth tokens vary", () => {
    expect(authoringOf({ ...defaults, node: "22", auth: "nextauth" })).toEqual(authoringOf(defaults));
  });

  test("tolerates the app-name answer the translator forwards alongside declared options", () => {
    const result = decompose({ ...defaults, name: "probe" });
    expect(result.provenance.options).toEqual({ ...defaults, name: "probe" });
    expect(authoringOf({ ...defaults, name: "probe" })).toEqual(authoringOf(defaults));
  });

  test.each([
    { options: { ...defaults, node: 22 }, path: "options.node" },
    { options: { ...defaults, node: "18" }, path: "options.node" },
    { options: { ...defaults, database: "mysql" }, path: "options.database" },
    { options: { ...defaults, auth: "auth0" }, path: "options.auth" },
    { options: { ...defaults, auth: true }, path: "options.auth" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(decomposer.decompose({ producer: nextjsProducer, options, secrets: {} })),
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
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(NEXTJS_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(nextjsSnapshot);
    expect(nextjsSnapshot.identity.contentDigest).toBe(
      "sha256:58a8c095d77b22d51563d16f4ea9828b22e6fece178bec6434c0f56594fd23bb",
    );
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives, noDatabase])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(nextjsSnapshot, options))).toEqual(authoringOf(options));
    },
  );
});
