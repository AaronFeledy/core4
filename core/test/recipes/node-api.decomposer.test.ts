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
import { nodeApiDecomposer } from "../../src/recipes/builtin/node-api/decomposer.ts";
import { nodeApiRecipeYaml } from "../../src/recipes/builtin/node-api/manifest.ts";
import {
  NODE_API_CONTENT_DIGEST,
  nodeApiDefaults,
  nodeApiProducer,
  nodeApiSnapshot,
} from "../../src/recipes/builtin/node-api/snapshot.ts";

const defaults = { ...nodeApiDefaults };
const alternatives = { node: "22", framework: "hono", database: "postgres" };
const noDatabase = { ...defaults, database: "none" };
const validInput: RecipeDecomposeInput = { producer: nodeApiProducer, options: defaults, secrets: {} };
const decomposer = nodeApiDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: nodeApiProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(nodeApiRecipeYaml));

describe("node-api decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "node-api",
        factory: nodeApiDecomposer,
        producer: nodeApiProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, node: 22 } },
        missingRecipeInput: { ...validInput, producer: { ...nodeApiProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "node-api",
      version: "0.1.0",
      producer: nodeApiProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        api: {
          type: "node:{{ recipe.node }}",
          port: 3000,
          environment: { API_FRAMEWORK: "{{ recipe.framework }}" },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          dependsOn: ["database"],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
        node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
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
    expect(Object.keys(authoring.services)).toEqual(["api"]);
    const api = Schema.decodeUnknownSync(Schema.Struct({ dependsOn: Schema.optional(Schema.Unknown) }))(
      authoring.services.api,
    );
    expect(api.dependsOn).toBeUndefined();
  });

  test("preserves authoring data when only Node and framework tokens vary", () => {
    expect(authoringOf({ ...defaults, node: "22", framework: "hono" })).toEqual(authoringOf(defaults));
  });

  test.each([
    { options: { ...defaults, node: 22 }, path: "options.node" },
    { options: { ...defaults, node: "18" }, path: "options.node" },
    { options: { ...defaults, framework: "koa" }, path: "options.framework" },
    { options: { ...defaults, database: "mysql" }, path: "options.database" },
    { options: { ...defaults, database: true }, path: "options.database" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(decomposer.decompose({ producer: nodeApiProducer, options, secrets: {} })),
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
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(NODE_API_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(nodeApiSnapshot);
    expect(nodeApiSnapshot.identity.contentDigest).toBe(
      "sha256:626bd72893e7a7a7497203b980754e9a4ba7d0dee5a3e1beb29ab6cf84cc1062",
    );
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives, noDatabase])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(nodeApiSnapshot, options))).toEqual(authoringOf(options));
    },
  );
});
