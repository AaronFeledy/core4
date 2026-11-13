import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import {
  DRUPAL_CONTRIB_CHROME_IMAGE,
  DRUPAL_CONTRIB_CORE_VERSION_RECIPE_COMMAND,
  DRUPAL_CONTRIB_MINK_DRIVER_ARGS,
  DRUPAL_CONTRIB_SCAFFOLD_COMMAND,
  DRUPAL_CONTRIB_SCAFFOLD_RECIPE_COMMAND,
  contribMountTarget,
  mysqlSimpletestDb,
  pgsqlSimpletestDb,
} from "../../src/recipes/builtin/drupal-contrib/commands.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";

const {
  decomposer: drupalContribDecomposer,
  defaults: drupalContribDefaults,
  producer: drupalContribProducer,
  snapshot: drupalContribSnapshot,
  contentDigest: DRUPAL_CONTRIB_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("drupal-contrib");

import { DRUSH_TOOLING_COMMAND } from "../../src/recipes/builtin/drush-command.ts";

const defaults = { ...drupalContribDefaults };
const alternatives = {
  project: "hello_theme",
  type: "theme",
  drupal: "^10",
  php: "8.3",
  webserver: "nginx",
  database: "postgres:16",
  composer: "2.7.7",
  webroot: "/app/docroot",
};
const validInput: RecipeDecomposeInput = { producer: drupalContribProducer, options: defaults, secrets: {} };
const decomposer = drupalContribDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, unknown>>) =>
  Effect.runSync(
    decomposer.decompose({ producer: drupalContribProducer, options, secrets: {} } as RecipeDecomposeInput),
  );

const authoringOf = (options: Readonly<Record<string, unknown>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

const contribDir = "/app";
const contribAppMount = contribMountTarget("{{ recipe.type }}", "{{ recipe.project }}");
const chromeService = {
  type: "compose",
  image: DRUPAL_CONTRIB_CHROME_IMAGE,
  appMount: false,
  home: false,
  shm_size: "2gb",
  healthcheck: {
    kind: "command",
    command: ["/opt/bin/check-grid.sh"],
    intervalSeconds: 5,
    retries: 24,
  },
};

describe("drupal-contrib decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "drupal-contrib",
        factory: drupalContribDecomposer,
        producer: drupalContribProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...drupalContribProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact Apache authoring fragment when default options are supplied", () => {
    expect(decompose(defaults).provenance).toEqual({
      id: "drupal-contrib",
      version: "0.1.0",
      producer: drupalContribProducer,
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
          workingDirectory: contribDir,
          dependsOn: ["database", "chrome"],
          appMount: { target: contribAppMount, includes: ["vendor", "node_modules", "tmp"] },
          storage: ["/app"],
          environment: {
            SIMPLETEST_BASE_URL: "http://appserver",
            SIMPLETEST_DB: mysqlSimpletestDb,
            BROWSERTEST_OUTPUT_DIRECTORY: "/app/web/sites/simpletest/browser_output",
            MINK_DRIVER_ARGS_WEBDRIVER: DRUPAL_CONTRIB_MINK_DRIVER_ARGS,
          },
          allowOverride: true,
          uploadDirs: ["sites/*/files"],
          port: 80,
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
        chrome: chromeService,
      },
      tooling: {
        drush: {
          service: "appserver",
          description: "Run Drush inside the appserver service.",
          cmds: [DRUSH_TOOLING_COMMAND],
          wrapper: true,
          dir: contribDir,
        },
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
          wrapper: true,
          dir: contribDir,
        },
        "drupal-contrib-scaffold": {
          service: "appserver",
          description: "Scaffold a Drupal site in the /app volume around the extension mount.",
          arguments: false,
          cmd: DRUPAL_CONTRIB_SCAFFOLD_RECIPE_COMMAND,
          dir: contribDir,
        },
        "core-version": {
          service: "appserver",
          description: "Update the Drupal core constraint in the site composer.json and Landofile.",
          cmd: DRUPAL_CONTRIB_CORE_VERSION_RECIPE_COMMAND,
          dir: contribDir,
        },
        phpunit: {
          service: "appserver",
          user: "www-data",
          description: "Run Drupal PHPUnit suites as the web server user.",
          cmd: ["vendor/bin/phpunit", "-c", "web/core"],
          dir: contribDir,
        },
        phpcs: {
          service: "appserver",
          description: "Run PHP_CodeSniffer (Drupal Coder) inside the appserver service.",
          cmds: ["vendor/bin/phpcs"],
          wrapper: true,
          dir: contribDir,
        },
        phpcbf: {
          service: "appserver",
          description: "Run phpcbf (Drupal Coder) inside the appserver service.",
          cmds: ["vendor/bin/phpcbf"],
          wrapper: true,
          dir: contribDir,
        },
        phpstan: {
          service: "appserver",
          description: "Run PHPStan from vendor/bin after core-dev is installed.",
          cmds: ["vendor/bin/phpstan"],
          wrapper: true,
          dir: contribDir,
        },
      },
    });
  });

  test("adds the nginx edge service and postgres SIMPLETEST_DB when nondefault options are supplied", () => {
    const authoring = authoringOf(alternatives) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(authoring.services).sort()).toEqual(["appserver", "chrome", "database", "edge"]);
    expect(authoring.services.appserver).toMatchObject({
      type: "php:{{ recipe.php }}",
      via: "fpm",
      appMount: { target: contribAppMount, includes: ["vendor", "node_modules", "tmp"] },
      environment: {
        SIMPLETEST_BASE_URL: "http://edge",
        SIMPLETEST_DB: pgsqlSimpletestDb,
      },
    });
    expect(authoring.services.edge).toEqual({
      type: "nginx",
      backend: "appserver",
      webroot: "{{ recipe.webroot }}",
      uploadDirs: ["sites/*/files"],
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    });
  });

  test("keeps the contrib scaffold interpolations and refuses to composer-require the extension", () => {
    const authoring = authoringOf(defaults) as { tooling: { "drupal-contrib-scaffold": { cmd: string } } };
    const command = authoring.tooling["drupal-contrib-scaffold"].cmd;
    expect(command).toBe(DRUPAL_CONTRIB_SCAFFOLD_RECIPE_COMMAND);
    expect(command).toContain("{{ recipe.drupal }}");
    expect(command).toContain("{{ recipe.project }}");
    expect(command).toContain("{{ recipe.type }}");
    expect(command).toContain("fill_tree");
    expect(command).toContain("composer create-project");
    expect(command).toContain("require --dev --no-update");
    expect(command).toContain("require --no-update --no-interaction drush/drush");
    expect(command).toContain('test ! -e "$app_root/web/$${type}s/contrib/$project"');
    expect(command.split("\n").length).toBeGreaterThan(10);
  });

  test.each([
    { options: { ...defaults, project: "Example" }, path: "options.project" },
    { options: { ...defaults, project: "my-module" }, path: "options.project" },
    { options: { ...defaults, type: "theme-engine" }, path: "options.type" },
    { options: { ...defaults, drupal: 11 }, path: "options.drupal" },
    { options: { ...defaults, drupal: "^11; rm -rf /" }, path: "options.drupal" },
    { options: { ...defaults, php: "5.6" }, path: "options.php" },
    { options: { ...defaults, webserver: "caddy" }, path: "options.webserver" },
    { options: { ...defaults, database: "sqlite" }, path: "options.database" },
    { options: { ...defaults, composer: "false" }, path: "options.composer" },
    { options: { ...defaults, webroot: "unsafe path" }, path: "options.webroot" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.result(
        decomposer.decompose({
          producer: drupalContribProducer,
          options,
          secrets: {},
        } as RecipeDecomposeInput),
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
    expect(await recompiledBundledDigest(manifest)).toBe(DRUPAL_CONTRIB_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(drupalContribSnapshot);
    expect(drupalContribSnapshot.identity.contentDigest).toBe(DRUPAL_CONTRIB_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Result.getOrThrow(renderRecipeSnapshot(drupalContribSnapshot, options))).toEqual(
        authoringOf(options),
      );
    },
  );

  test.skipIf(process.platform === "win32")("keeps the scaffold command valid as a shell script", () => {
    const result = Bun.spawnSync(["sh", "-n", "-c", DRUPAL_CONTRIB_SCAFFOLD_COMMAND]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
});
