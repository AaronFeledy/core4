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
import { drupalDecomposer } from "../../src/recipes/builtin/drupal/decomposer.ts";
import { drupalRecipeYaml } from "../../src/recipes/builtin/drupal/manifest.ts";
import { drupalScaffoldCommand } from "../../src/recipes/builtin/drupal/scaffold-command.ts";
import {
  DRUPAL_CONTENT_DIGEST,
  drupalDefaults,
  drupalProducer,
  drupalSnapshot,
} from "../../src/recipes/builtin/drupal/snapshot.ts";

const defaults = { ...drupalDefaults };
const alternatives = {
  drupal: "10",
  php: "8.4",
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
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(drupalRecipeYaml));

const scaffoldTooling = {
  service: "appserver",
  description: "Scaffold Drupal and project-local Drush into the mounted app root.",
  arguments: false,
  cmd: drupalScaffoldCommand("{{ recipe.drupal }}"),
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
          framework: "drupal",
          webroot: "{{ recipe.webroot }}",
          composer: "{{ recipe.composer }}",
          allowOverride: true,
          port: 80,
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        drush: {
          service: "appserver",
          description: "Run Drush inside the appserver service.",
          cmds: ["vendor/bin/drush"],
        },
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
        },
        "drupal-scaffold": scaffoldTooling,
      },
    });
  });

  test("adds the nginx edge service when nondefault options select nginx", () => {
    const authoring = authoringOf(alternatives) as { services: Record<string, unknown> };
    expect(Object.keys(authoring.services)).toEqual(["appserver", "edge", "database"]);
    expect(authoring.services.appserver).toEqual({
      type: "php:{{ recipe.php }}",
      framework: "drupal",
      via: "fpm",
      webroot: "{{ recipe.webroot }}",
      composer: "{{ recipe.composer }}",
      dependsOn: ["database"],
    });
    expect(authoring.services.edge).toEqual({
      type: "nginx",
      backend: "appserver",
      webroot: "{{ recipe.webroot }}",
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    });
  });

  test("defers the Drupal major version to the recipe option scope in the scaffold command", () => {
    const authoring = authoringOf(alternatives) as { tooling: { "drupal-scaffold": { cmd: string } } };
    const command = authoring.tooling["drupal-scaffold"].cmd;
    expect(command).toContain("composer create-project 'drupal/recommended-project:^{{ recipe.drupal }}'");
    expect(command.split("\n").length).toBeGreaterThan(10);
    expect(command).toBe(drupalScaffoldCommand("{{ recipe.drupal }}"));
  });

  test.each([
    { options: { ...defaults, drupal: 11 }, path: "options.drupal" },
    { options: { ...defaults, drupal: "9" }, path: "options.drupal" },
    { options: { ...defaults, php: "5.6" }, path: "options.php" },
    { options: { ...defaults, webserver: "caddy" }, path: "options.webserver" },
    { options: { ...defaults, database: "sqlite" }, path: "options.database" },
    { options: { ...defaults, composer: "false" }, path: "options.composer" },
    { options: { ...defaults, webroot: "web" }, path: "options.webroot" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(
        decomposer.decompose({ producer: drupalProducer, options, secrets: {} } as RecipeDecomposeInput),
      ),
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
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(DRUPAL_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(drupalSnapshot);
    expect(drupalSnapshot.identity.contentDigest).toBe(DRUPAL_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(drupalSnapshot, options))).toEqual(authoringOf(options));
    },
  );
});
