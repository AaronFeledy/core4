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
import { DRUPAL_CMS_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal-cms/commands.ts";
import { drupalCmsDecomposer } from "../../src/recipes/builtin/drupal-cms/decomposer.ts";
import { drupalCmsRecipeYaml } from "../../src/recipes/builtin/drupal-cms/manifest.ts";
import {
  DRUPAL_CMS_CONTENT_DIGEST,
  DRUPAL_CMS_MYSQL_INSTALL_COMMAND,
  DRUPAL_CMS_PGSQL_INSTALL_COMMAND,
  drupalCmsDefaults,
  drupalCmsProducer,
  drupalCmsSnapshot,
} from "../../src/recipes/builtin/drupal-cms/snapshot.ts";

const defaults = { ...drupalCmsDefaults };
const alternatives = {
  php: "8.2",
  webserver: "nginx",
  database: "postgres:16",
  composer: "2.7.7",
  webroot: "/app/docroot",
};
const validInput: RecipeDecomposeInput = { producer: drupalCmsProducer, options: defaults, secrets: {} };
const decomposer = drupalCmsDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, unknown>>) =>
  Effect.runSync(
    decomposer.decompose({ producer: drupalCmsProducer, options, secrets: {} } as RecipeDecomposeInput),
  );

const authoringOf = (options: Readonly<Record<string, unknown>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(drupalCmsRecipeYaml));

describe("drupal-cms decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "drupal-cms",
        factory: drupalCmsDecomposer,
        producer: drupalCmsProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...drupalCmsProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact Apache authoring fragment when default options are supplied", () => {
    expect(decompose(defaults).provenance).toEqual({
      id: "drupal-cms",
      version: "0.1.0",
      producer: drupalCmsProducer,
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
        database: { type: "{{ recipe.database }}", database: "{{ app.name }}" },
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
        "drupal-cms-scaffold": {
          service: "appserver",
          description: "Scaffold Drupal CMS 2 and project-local Drush into the mounted app root.",
          arguments: false,
          cmd: DRUPAL_CMS_SCAFFOLD_COMMAND,
        },
        "drupal-cms-install": {
          service: "appserver",
          description: "Install Drupal CMS 2 using the drupal_cms_starter recipe.",
          arguments: false,
          cmd: DRUPAL_CMS_MYSQL_INSTALL_COMMAND,
        },
      },
    });
  });

  test("selects the PostgreSQL install command and the nginx edge for nondefault options", () => {
    const authoring = authoringOf(alternatives) as {
      services: Record<string, unknown>;
      tooling: { "drupal-cms-install": { cmd: string } };
    };
    expect(Object.keys(authoring.services)).toEqual(["appserver", "edge", "database"]);
    expect(authoring.tooling["drupal-cms-install"].cmd).toBe(DRUPAL_CMS_PGSQL_INSTALL_COMMAND);
    expect(authoring.tooling["drupal-cms-install"].cmd).toContain('--db-url="pgsql://lando:');
    expect(authoring.tooling["drupal-cms-install"].cmd).toContain("{{ app.name }}");
  });

  test("keeps the multiline scaffold command intact through snapshot encoding", () => {
    const rendered = Either.getOrThrow(renderRecipeSnapshot(drupalCmsSnapshot, defaults)) as {
      tooling: { "drupal-cms-scaffold": { cmd: string } };
    };
    expect(rendered.tooling["drupal-cms-scaffold"].cmd).toBe(DRUPAL_CMS_SCAFFOLD_COMMAND);
    expect(DRUPAL_CMS_SCAFFOLD_COMMAND).toContain('"$app_root"');
    expect(DRUPAL_CMS_SCAFFOLD_COMMAND.split("\n").length).toBeGreaterThan(10);
  });

  test.each([
    { options: { ...defaults, php: 83 }, path: "options.php" },
    { options: { ...defaults, webserver: "caddy" }, path: "options.webserver" },
    { options: { ...defaults, database: "sqlite" }, path: "options.database" },
    { options: { ...defaults, composer: "false" }, path: "options.composer" },
    { options: { ...defaults, webroot: "web" }, path: "options.webroot" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(
        decomposer.decompose({ producer: drupalCmsProducer, options, secrets: {} } as RecipeDecomposeInput),
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
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(
      DRUPAL_CMS_CONTENT_DIGEST,
    );
    expect(manifest.snapshot).toEqual(drupalCmsSnapshot);
    expect(drupalCmsSnapshot.identity.contentDigest).toBe(DRUPAL_CMS_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(drupalCmsSnapshot, options))).toEqual(
        authoringOf(options),
      );
    },
  );
});
