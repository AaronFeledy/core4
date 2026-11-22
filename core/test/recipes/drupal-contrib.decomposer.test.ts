import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import {
  DRUPAL_CONTRIB_CHROME_IMAGE,
  DRUPAL_CONTRIB_MINK_DRIVER_ARGS,
  contribMountTarget,
  contribSyncArgv,
  mysqlSimpletestDb,
  pgsqlSimpletestDb,
} from "../../src/recipes/builtin/drupal-contrib/stack.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";

const {
  decomposer: drupalContribDecomposer,
  defaults: drupalContribDefaults,
  producer: drupalContribProducer,
  snapshot: drupalContribSnapshot,
  contentDigest: DRUPAL_CONTRIB_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("drupal-contrib");

const defaults = { ...drupalContribDefaults };
const alternatives = {
  project: "hello_theme",
  type: "theme",
  drupal: "^10",
  php: "8.3",
  webserver: "nginx",
  database: "postgres:16",
  composer: "2.7.7",
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
    const { tooling, ...config } = authoringOf(defaults) as {
      tooling: Record<string, Record<string, unknown>>;
    };
    expect(config).toEqual({
      runtime: 4,
      events: { "post-start": [{ task: "drupal-contrib-sync" }] },
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "drupal",
          webroot: "/app/web",
          composer: "{{ recipe.composer }}",
          workingDirectory: contribDir,
          dependsOn: ["database", "chrome"],
          appMount: { target: contribAppMount, includes: ["vendor", "node_modules", "tmp"] },
          mounts: ["site:/app"],
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
    });
    // Machine fields only: descriptions are reader copy.
    const machine = Object.fromEntries(
      Object.entries(tooling).map(([name, { description: _description, ...task }]) => [name, task]),
    );
    expect(machine).toEqual({
      drush: { service: "appserver", cmd: [":drupal-local", "drush"], wrapper: true, dir: contribDir },
      composer: { service: "appserver", cmds: ["composer"], wrapper: true, dir: contribDir },
      "drupal-contrib-sync": {
        service: "appserver",
        arguments: false,
        cmd: [...contribSyncArgv],
        dir: contribDir,
      },
      phpunit: {
        service: "appserver",
        user: "www-data",
        cmd: ["/app/vendor/bin/phpunit", "-c", "/app/web/core"],
        wrapper: true,
      },
      phpcs: { service: "appserver", cmd: [":drupal-local", "phpcs"], wrapper: true },
      phpcbf: { service: "appserver", cmd: [":drupal-local", "phpcbf"], wrapper: true },
      phpstan: { service: "appserver", cmd: [":drupal-local", "phpstan"], wrapper: true },
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
      webroot: "/app/web",
      uploadDirs: ["sites/*/files"],
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
      appMount: { target: contribAppMount, includes: ["vendor", "node_modules", "tmp"] },
      mounts: ["site:/app:ro"],
    });
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
});
