import type { RecipeSource } from "@lando/sdk/schema";
import { CONTRIB_DRUSH_TOOLING_COMMAND } from "../drush-command.ts";
import { contribQualityTooling } from "../php-quality-command.ts";
import { composerTool, drupalOptions, drupalWebVariantsFor, phpAppserver } from "../source-php.ts";
import {
  DRUPAL_CONTRIB_CHROME_IMAGE,
  DRUPAL_CONTRIB_MINK_DRIVER_ARGS,
  contribMountTarget,
  contribSyncArgv,
  mysqlSimpletestDb,
  pgsqlSimpletestDb,
} from "./stack.ts";

const contribDir = "/app";
/** The scaffold installs drupal/recommended-project, whose docroot is always web/. */
const contribWebroot = `${contribDir}/web`;
const { webroot: _siteWebroot, ...contribStackOptions } = drupalOptions;
/**
 * One app-scoped volume holds the Drupal site, so the nginx edge serves the
 * same tree the appserver scaffolds. Each service nests the checkout in it.
 */
const contribSiteVolume = `site:${contribDir}`;
const contribAppMount = {
  target: contribMountTarget("{{ recipe.type }}", "{{ recipe.project }}"),
  includes: ["vendor", "node_modules", "tmp"],
};

const contribAppserver = {
  ...phpAppserver("drupal"),
  webroot: contribWebroot,
  workingDirectory: contribDir,
  dependsOn: ["database", "chrome"],
  appMount: contribAppMount,
  mounts: [contribSiteVolume],
  environment: {
    SIMPLETEST_BASE_URL: "http://appserver",
    SIMPLETEST_DB: mysqlSimpletestDb,
    BROWSERTEST_OUTPUT_DIRECTORY: "/app/web/sites/simpletest/browser_output",
    MINK_DRIVER_ARGS_WEBDRIVER: DRUPAL_CONTRIB_MINK_DRIVER_ARGS,
  },
};

const contribToolingDir = { dir: contribDir } as const;

export const source = {
  id: "drupal-contrib",
  title: "Drupal contrib",
  description:
    "Drupal contrib extension with a container Drupal site, nested app mount, and project-local test tooling.",
  version: "0.1.0",
  authors: ["Lando Core Team"],
  tags: ["drupal", "drupal-contrib", "php", "mariadb", "phpunit"],
  options: {
    project: {
      type: { kind: "string", pattern: "^[a-z][a-z0-9_]*$" },
      default: "example",
      prompt: {
        message: "Extension machine name",
        validationMessage: "Machine name must match the root *.info.yml, such as my_module.",
      },
    },
    type: {
      type: { kind: "enum", values: ["module", "theme", "profile"] },
      default: "module",
      prompt: { message: "Extension type" },
    },
    drupal: {
      type: { kind: "string", pattern: "^[v0-9^~<>=*.,@| a-zA-Z-]+$" },
      default: "^11",
      prompt: { message: "Drupal core constraint" },
    },
    ...contribStackOptions,
  },
  config: {
    runtime: 4,
    // Every start, restart, and rebuild brings the site in line; an unchanged one costs no Composer call.
    events: { "post-start": [{ task: "drupal-contrib-sync" }] },
    services: {
      appserver: contribAppserver,
      database: { type: "{{ recipe.database }}" },
      chrome: {
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
      },
    },
    tooling: {
      drush: {
        service: "appserver",
        description: "Run Drush for the scaffolded Drupal site in /app.",
        cmds: [CONTRIB_DRUSH_TOOLING_COMMAND],
        wrapper: true,
        ...contribToolingDir,
      },
      composer: {
        ...composerTool,
        description: "Run Composer for the scaffolded Drupal site in /app.",
        ...contribToolingDir,
      },
      "drupal-contrib-sync": {
        service: "appserver",
        description:
          "Build or update the Drupal site in /app to match .lando.yml and the extension's composer.json.",
        arguments: false,
        cmd: contribSyncArgv,
        ...contribToolingDir,
      },
      phpunit: {
        service: "appserver",
        user: "www-data",
        description: "Run Drupal PHPUnit tests as the web server user, from your current directory.",
        cmd: [`${contribDir}/vendor/bin/phpunit`, "-c", `${contribDir}/web/core`],
        wrapper: true,
      },
      ...contribQualityTooling,
    },
  },
  variants: [
    ...drupalWebVariantsFor(contribWebroot),
    {
      when: '{{ eq(options.webserver, "nginx") }}',
      config: {
        services: {
          appserver: { environment: { SIMPLETEST_BASE_URL: "http://edge" } },
          edge: { appMount: contribAppMount, mounts: [`${contribSiteVolume}:ro`] },
        },
      },
    },
    {
      when: '{{ eq(options.database, "postgres:16") }}',
      config: {
        services: {
          appserver: { environment: { SIMPLETEST_DB: pgsqlSimpletestDb } },
        },
      },
    },
  ],
  postInit: [
    {
      type: "message",
      text: "Run 'lando start' from the extension root. The first start builds the Drupal site around your extension, which takes a few minutes.",
    },
  ],
} as const satisfies RecipeSource;
