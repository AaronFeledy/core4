import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { laravelDecomposer } from "../../src/recipes/builtin/laravel/decomposer.ts";
import { laravelRecipeYaml } from "../../src/recipes/builtin/laravel/manifest.ts";
import { laravelProducer, laravelSnapshot } from "../../src/recipes/builtin/laravel/snapshot.ts";

const defaults = {
  php: "8.3",
  database: "mariadb:11.4",
  composer: "2",
  webroot: "/app/public",
  worker: false,
};
const alternate = {
  php: "8.4",
  database: "postgres:16",
  composer: "2.7.7",
  webroot: "/app/web",
  worker: true,
};
const composerFalse = { ...defaults, composer: "false" };
const validInput: RecipeDecomposeInput = { producer: laravelProducer, options: defaults, secrets: {} };
const decomposer = laravelDecomposer({ redactor: createStandaloneRedactor("secrets") });
const expected = {
  runtime: 4,
  services: {
    appserver: {
      type: "php:{{ recipe.php }}",
      framework: "laravel",
      webroot: "{{ recipe.webroot }}",
      composer: "{{ recipe.composer }}",
      allowOverride: true,
      port: 80,
      dependsOn: ["database", "cache"],
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    },
    database: { type: "{{ recipe.database }}" },
    cache: { type: "redis" },
  },
  tooling: {
    artisan: {
      service: "appserver",
      description: "Run a Laravel Artisan command inside the appserver service.",
      cmds: ["php artisan"],
    },
    composer: {
      service: "appserver",
      description: "Run Composer inside the appserver service.",
      cmds: ["composer"],
    },
    npm: { service: "appserver", description: "Run npm inside the appserver service.", cmds: ["npm"] },
  },
};

describe("Laravel deterministic decomposition", () => {
  test("satisfies the provider-free decomposer contract", async () => {
    // Given valid, mistyped, and missing-recipe inputs; when the contract runs; then every assertion holds.
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "laravel",
        factory: laravelDecomposer,
        producer: laravelProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...laravelProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when defaults are supplied", () => {
    // Given defaults; when decomposed; then name is absent and provenance is retained exactly.
    const result = Effect.runSync(decomposer.decompose(validInput));
    const provenance = { id: "laravel", version: "0.1.0", producer: laravelProducer, options: defaults };
    expect<unknown>(result).toEqual({ fragment: { ...expected, recipe: provenance }, provenance });
  });

  test("includes the CLI queue worker when enabled with non-default options", () => {
    // Given alternate options; when decomposed; then only the selected worker structure is added.
    const { fragment, provenance } = Effect.runSync(
      decomposer.decompose({ ...validInput, options: alternate }),
    );
    expect<unknown>(fragment).toEqual({
      ...expected,
      recipe: provenance,
      services: {
        ...expected.services,
        worker: {
          type: "php:{{ recipe.php }}",
          framework: "laravel",
          via: "cli",
          command: "php artisan queue:work",
          dependsOn: ["database", "cache"],
        },
      },
    });
    expect(provenance.options).toEqual(alternate);
  });

  test("disables Composer and omits its tooling when composer is false", () => {
    // Given the renderer-supported false string; when decomposed; then neither Composer path stays enabled.
    const { fragment, provenance } = Effect.runSync(
      decomposer.decompose({ ...validInput, options: composerFalse }),
    );
    expect<unknown>(fragment).toEqual({
      ...expected,
      recipe: provenance,
      services: { ...expected.services, appserver: { ...expected.services.appserver, composer: false } },
      tooling: { artisan: expected.tooling.artisan, npm: expected.tooling.npm },
    });
  });

  test.each([
    ["php", 83],
    ["php", "9.0"],
    ["database", false],
    ["database", "mysql:8.0"],
    ["composer", 2],
    ["composer", "3"],
    ["webroot", false],
    ["webroot", "relative"],
    ["webroot", "/app/unsafe path"],
    ["worker", "true"],
  ] as const)("rejects invalid %s option %s with its typed path", (name, value) => {
    // Given one invalid option; when decomposed; then failure identifies that option without echoing it.
    const error = Effect.runSync(
      Effect.flip(decomposer.decompose({ ...validInput, options: { ...defaults, [name]: value } })),
    );
    expect(error).toMatchObject({
      _tag: "RecipeDecomposeError",
      reason: "option-type",
      path: `options.${name}`,
    });
  });

  test("publishes a complete, digest-consistent migratable snapshot", () => {
    // Given published YAML; when decoded; then its declarative inventory and identity agree.
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(laravelRecipeYaml));
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect(manifest.postInit).toEqual([
      { type: "message", text: "Run 'lando start' inside the new app directory to bring Laravel up." },
    ]);
    expect(manifest.snapshot).toEqual(laravelSnapshot);
    expect(manifest.snapshot?.assets).toEqual([]);
    expect(laravelSnapshot.defaults).toEqual(defaults);
    expect(laravelSnapshot.optionTypes).toEqual({
      php: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5"] },
      database: { kind: "enum", values: ["mariadb:11.4", "postgres:16"] },
      composer: { kind: "enum", values: ["2", "2.7.7"] },
      webroot: { kind: "string", pattern: "^/[A-Za-z0-9._/-]*$" },
      worker: { kind: "boolean" },
    });
    expect<unknown>(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(
      laravelProducer.contentDigest,
    );
    expect(laravelSnapshot.identity.recipeId).toBe(manifest.id);
    expect(laravelSnapshot.identity.manifestVersion).toBe(manifest.version);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternate, composerFalse])("snapshot agrees with decomposition for %j", (options) => {
    // Given each structural selection; when the inert snapshot renders; then it matches decomposition.
    const result = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    if (typeof result.fragment === "string") throw new TypeError("Expected an object fragment.");
    const { recipe: _recipe, ...fragment } = result.fragment;
    expect(Either.getOrThrow(renderRecipeSnapshot(laravelSnapshot, options))).toEqual(fragment);
  });
});
