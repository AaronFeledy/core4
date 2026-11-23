import type { RecipeSource } from "@lando/sdk/schema";
import { drupalTestingConfig, drupalTestingOverrides } from "../drupal-testing.ts";
import { drupalTool } from "../drupal-tooling.ts";
import { composerTool, drupalOptions, drupalWebVariantsFor, phpAppserver } from "../source-php.ts";
import { contribMountTarget, contribSyncArgv } from "./stack.ts";

const contribDir = "/app";
/** The scaffold installs drupal/recommended-project, whose docroot is always web/. */
const contribWebroot = `${contribDir}/web`;
const testing = drupalTestingConfig(contribWebroot);
/**
 * One app-scoped volume holds the Drupal site, so the nginx edge serves the
 * same tree the appserver scaffolds. Each service nests the checkout in it.
 */
const contribSiteVolume = `site:${contribDir}`;
const contribAppMount = {
  target: contribMountTarget("{{ recipe.type }}", "{{ recipe.project }}"),
};

const contribAppserver = {
  ...phpAppserver("drupal"),
  webroot: contribWebroot,
  working_dir: contribDir,
  ...testing.services.appserver,
  appMount: contribAppMount,
  mounts: [contribSiteVolume],
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
  },
  config: {
    runtime: 4,
    // Every start, restart, and rebuild brings the site in line; an unchanged one costs no Composer call.
    events: { "post-start": [{ task: "drupal-contrib-sync" }] },
    services: {
      appserver: contribAppserver,
      database: { type: "{{ recipe.database }}" },
      chrome: testing.services.chrome,
    },
    tooling: {
      drush: {
        ...drupalTool("drush", "Run Drush for the scaffolded Drupal site in /app."),
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
      ...testing.tooling,
      phpcs: drupalTool("phpcs", "Run PHP_CodeSniffer with Drupal Coder from your current directory."),
      phpcbf: drupalTool("phpcbf", "Run phpcbf with Drupal Coder from your current directory."),
      phpstan: drupalTool("phpstan", "Run PHPStan from your current directory."),
    },
  },
  variants: [
    ...drupalWebVariantsFor(contribWebroot),
    ...drupalTestingOverrides(false),
    {
      when: '{{ eq(options.webserver, "nginx") }}',
      config: {
        services: {
          edge: { appMount: contribAppMount, mounts: [`${contribSiteVolume}:ro`] },
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
