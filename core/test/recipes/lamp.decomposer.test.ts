import { describe, expect, test } from "bun:test";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { parse } from "yaml";
import { lampDecomposer } from "../../src/recipes/builtin/lamp/decomposer.ts";
import { lampRecipeYaml } from "../../src/recipes/builtin/lamp/manifest.ts";
import { lampProducer, lampSnapshot } from "../../src/recipes/builtin/lamp/snapshot.ts";

const defaults = { php: "8.3", database: "mariadb:11.4", composer: "2", webroot: "/app" };
const alternatives = { php: "8.4", database: "mysql:8.0", composer: "false", webroot: "/app/web" };
const validInput: RecipeDecomposeInput = { producer: lampProducer, options: defaults, secrets: {} };
const decomposer = lampDecomposer({
  redactor: { redactString: (text) => text, redactValue: (value) => value },
});
const expectedServices = {
  appserver: {
    type: "php:{{ recipe.php }}",
    framework: "none",
    webroot: "{{ recipe.webroot }}",
    composer: "{{ recipe.composer }}",
    port: 80,
    dependsOn: ["database"],
    routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
  },
  database: { type: "{{ recipe.database }}" },
};
const phpTool = {
  service: "appserver",
  description: "Run the PHP CLI inside the appserver service.",
  cmds: ["php"],
};

describe("lamp decomposition", () => {
  test("satisfies the provider-free decomposer contract when inputs are valid or invalid", async () => {
    // Given / When: the real factory and representative input boundaries.
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "lamp",
        factory: lampDecomposer,
        producer: lampProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...lampProducer, recipeId: "missing" } },
      }),
    );
    // Then: the contract completes without a failure.
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    // Given / When
    const result = Effect.runSync(decomposer.decompose(validInput));
    // Then
    const provenance = { id: "lamp", version: "0.1.0", producer: lampProducer, options: defaults };
    expect<unknown>(result).toEqual({
      provenance,
      fragment: {
        runtime: 4,
        recipe: provenance,
        services: expectedServices,
        tooling: {
          composer: {
            service: "appserver",
            description: "Run Composer inside the appserver service.",
            cmds: ["composer"],
          },
          php: phpTool,
        },
      },
    });
  });

  test("removes Composer tooling when non-default options disable Composer", () => {
    // Given
    const input = { ...validInput, options: alternatives };
    // When
    const { fragment, provenance } = Effect.runSync(decomposer.decompose(input));
    // Then
    expect<unknown>(fragment).toEqual({
      runtime: 4,
      recipe: provenance,
      services: { ...expectedServices, appserver: { ...expectedServices.appserver, composer: false } },
      tooling: { php: phpTool },
    });
    expect<unknown>(provenance.options).toEqual(alternatives);
  });

  test.each([
    ["php", 83],
    ["php", "9.0"],
    ["database", false],
    ["database", "postgres:16"],
    ["composer", false],
    ["composer", "3"],
    ["webroot", 42],
    ["webroot", "relative"],
    ["webroot", "/app;bad"],
  ] as const)("rejects %s=%s with a typed option path", (name, value) => {
    // Given
    const input = { ...validInput, options: { ...defaults, [name]: value } };
    // When
    const error = Effect.runSync(Effect.flip(decomposer.decompose(input)));
    // Then
    expect(error).toMatchObject({
      _tag: "RecipeDecomposeError",
      reason: "option-type",
      path: `options.${name}`,
    });
  });

  test("publishes an explicit empty auxiliary inventory when decoding the manifest", () => {
    // Given / When
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(parse(lampRecipeYaml));
    // Then
    expect<unknown>(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect<unknown>(manifest.postInit).toEqual([
      { type: "message", text: "Run 'lando start' inside the new app directory to bring the LAMP stack up." },
    ]);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a migratable snapshot with matching content identity", () => {
    // Given
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(parse(lampRecipeYaml));
    // When
    const digest = computeRecipeContentDigest(recipeContentDigestProjection(manifest));
    // Then
    expect<unknown>(digest).toBe(manifest.snapshot?.identity.contentDigest);
    expect(manifest.snapshot?.identity.recipeId).toBe(manifest.id);
    expect(manifest.snapshot?.identity.manifestVersion).toBe(manifest.version);
    expect(fullRecipeMigratability(manifest, "bundled")).toEqual({ status: "migratable" });
  });

  test.each([defaults, alternatives])("agrees with the snapshot when options are %j", (options) => {
    // Given
    const { fragment } = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    const { recipe: _recipe, ...authoring } = fragment;
    // When
    const rendered = Either.getOrThrow(renderRecipeSnapshot(lampSnapshot, options));
    // Then
    expect(rendered).toEqual(authoring);
  });
});
