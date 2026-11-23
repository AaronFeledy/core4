import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";

const {
  decomposer: drupalDecomposer,
  defaults: drupalDefaults,
  producer: drupalProducer,
  snapshot: drupalSnapshot,
  contentDigest: DRUPAL_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("drupal");

const defaults = { ...drupalDefaults };
const alternatives = {
  drupal: "10",
  php: "8.1",
  webserver: "nginx",
  database: "postgres:16",
  composer: "2.7.7",
  webroot: "/app/docroot",
};
const validInput: RecipeDecomposeInput = { producer: drupalProducer, options: defaults, secrets: {} };
const decomposer = drupalDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, unknown>>) =>
  Effect.runSync(
    decomposer.decompose({ producer: drupalProducer, options, secrets: {} } as RecipeDecomposeInput),
  );

const authoringOf = (options: Readonly<Record<string, unknown>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

const scaffoldAppStep = {
  run: 'lando-drupal-scaffold 11 "$LANDO_WEBROOT" --testing=false',
};

describe("drupal decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "drupal",
        factory: drupalDecomposer,
        producer: drupalProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...drupalProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact Apache authoring fragment when default options are supplied", () => {
    expect(decompose(defaults).provenance).toEqual({
      id: "drupal",
      version: "0.1.0",
      producer: drupalProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "drupal",
          webroot: "{{ recipe.webroot }}",
          composer: "{{ recipe.composer }}",
          allowOverride: true,
          uploadDirs: ["sites/*/files"],
          port: 80,
          depends_on: ["database"],
          build: { app: [scaffoldAppStep] },
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        drush: {
          service: "appserver",
          description: "Run Drush inside the appserver service.",
          cmd: [":drupal-local", "drush"],
          wrapper: true,
        },
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
          wrapper: true,
        },
        phpcs: {
          service: "appserver",
          cmd: [":drupal-local", "phpcs"],
          wrapper: true,
          description: "Run PHP_CodeSniffer inside the appserver service.",
        },
        phpcbf: {
          service: "appserver",
          cmd: [":drupal-local", "phpcbf"],
          wrapper: true,
          description: "Run phpcbf inside the appserver service.",
        },
        phpstan: {
          service: "appserver",
          cmd: [":drupal-local", "phpstan"],
          wrapper: true,
          description: "Run PHPStan inside the appserver service.",
        },
      },
    });
  });

  test("adds the nginx edge service when nondefault options select nginx", () => {
    const authoring = authoringOf(alternatives) as { services: Record<string, unknown> };
    expect(Object.keys(authoring.services).sort()).toEqual(["appserver", "database", "edge"]);
    expect(authoring.services.appserver).toEqual({
      type: "php:{{ recipe.php }}",
      primary: true,
      framework: "drupal",
      via: "fpm",
      webroot: "{{ recipe.webroot }}",
      composer: "{{ recipe.composer }}",
      depends_on: ["database"],
      build: { app: [{ run: 'lando-drupal-scaffold 10 "$LANDO_WEBROOT" --testing=false' }] },
    });
    expect(authoring.services.edge).toEqual({
      type: "nginx",
      backend: "appserver",
      webroot: "{{ recipe.webroot }}",
      uploadDirs: ["sites/*/files"],
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    });
  });

  test("pins the chosen major and enables testing in the generated scaffold", () => {
    const authoring = authoringOf({ ...alternatives, drupal: "10", testing: true }) as {
      services: { appserver: { build: { app: ReadonlyArray<{ run: string; user?: string }> } } };
      tooling: Record<string, unknown>;
    };
    expect(authoring.services.appserver.build.app).toEqual([
      { run: 'lando-drupal-scaffold 10 "$LANDO_WEBROOT" --testing=true' },
    ]);
    expect(authoring.services.appserver.build.app).toHaveLength(1);
    expect(authoring.services.appserver.build.app[0]).not.toHaveProperty("user");
    expect(authoring.tooling["drupal-scaffold"]).toBeUndefined();
  });

  test.each([
    { options: { ...defaults, drupal: 11 }, path: "options.drupal" },
    { options: { ...defaults, drupal: "9" }, path: "options.drupal" },
    { options: { ...defaults, php: "5.6" }, path: "options.php" },
    { options: { ...defaults, webserver: "caddy" }, path: "options.webserver" },
    { options: { ...defaults, database: "sqlite" }, path: "options.database" },
    { options: { ...defaults, composer: "false" }, path: "options.composer" },
    { options: { ...defaults, webroot: "unsafe path" }, path: "options.webroot" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.result(
        decomposer.decompose({ producer: drupalProducer, options, secrets: {} } as RecipeDecomposeInput),
      ),
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
    expect(await recompiledBundledDigest(manifest)).toBe(DRUPAL_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(drupalSnapshot);
    expect(drupalSnapshot.identity.contentDigest).toBe(DRUPAL_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Result.getOrThrow(renderRecipeSnapshot(drupalSnapshot, options))).toEqual(authoringOf(options));
    },
  );
});
