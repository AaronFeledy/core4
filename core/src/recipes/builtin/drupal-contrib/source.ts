import type { RecipeSource } from "@lando/sdk/schema";
import { DRUSH_TOOLING_COMMAND } from "../drush-command.ts";
import {
  composerTool,
  drupalOptions,
  drupalWebVariants,
  phpAppserver,
  webrootOption,
} from "../source-php.ts";
import {
  DRUPAL_CONTRIB_CHROME_IMAGE,
  DRUPAL_CONTRIB_CORE_VERSION_RECIPE_COMMAND,
  DRUPAL_CONTRIB_MINK_DRIVER_ARGS,
  DRUPAL_CONTRIB_SCAFFOLD_RECIPE_COMMAND,
  contribMountTarget,
  mysqlSimpletestDb,
  pgsqlSimpletestDb,
} from "./commands.ts";

const contribDir = "/app";
const contribAppMount = contribMountTarget("{{ recipe.type }}", "{{ recipe.project }}");

const contribAppserver = {
  ...phpAppserver("drupal"),
  webroot: "{{ recipe.webroot }}",
  workingDirectory: contribDir,
  dependsOn: ["database", "chrome"],
  appMount: { target: contribAppMount },
  storage: [{ store: "app", target: contribDir, scope: "app", kind: "data" }],
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
    ...drupalOptions,
    webroot: webrootOption("/app/web"),
  },
  config: {
    runtime: 4,
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
        description: "Run Drush inside the appserver service.",
        cmds: [DRUSH_TOOLING_COMMAND],
        wrapper: true,
        ...contribToolingDir,
      },
      composer: {
        ...composerTool,
        ...contribToolingDir,
      },
      "drupal-contrib-scaffold": {
        service: "appserver",
        description: "Scaffold a Drupal site in the /app volume around the extension mount.",
        arguments: false,
        cmd: DRUPAL_CONTRIB_SCAFFOLD_RECIPE_COMMAND,
        ...contribToolingDir,
      },
      "core-version": {
        service: "appserver",
        description: "Update the Drupal core constraint in the site composer.json and Landofile.",
        cmd: DRUPAL_CONTRIB_CORE_VERSION_RECIPE_COMMAND,
        ...contribToolingDir,
      },
      phpunit: {
        service: "appserver",
        user: "www-data",
        description: "Run Drupal PHPUnit suites as the web server user.",
        cmd: ["vendor/bin/phpunit", "-c", "web/core"],
        ...contribToolingDir,
      },
      phpcs: {
        service: "appserver",
        description: "Run PHP_CodeSniffer (Drupal Coder) inside the appserver service.",
        cmds: ["vendor/bin/phpcs"],
        wrapper: true,
        ...contribToolingDir,
      },
      phpcbf: {
        service: "appserver",
        description: "Run phpcbf (Drupal Coder) inside the appserver service.",
        cmds: ["vendor/bin/phpcbf"],
        wrapper: true,
        ...contribToolingDir,
      },
      phpstan: {
        service: "appserver",
        description: "Run PHPStan from vendor/bin after core-dev is installed.",
        cmds: ["vendor/bin/phpstan"],
        wrapper: true,
        ...contribToolingDir,
      },
    },
  },
  variants: [
    ...drupalWebVariants,
    {
      when: '{{ eq(options.webserver, "nginx") }}',
      config: {
        services: {
          appserver: { environment: { SIMPLETEST_BASE_URL: "http://edge" } },
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
      text: "Run 'lando start' from the extension root, then scaffold the Drupal site around the mount with 'lando drupal-contrib-scaffold'.",
    },
  ],
} as const satisfies RecipeSource;
