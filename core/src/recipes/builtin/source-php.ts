import type { RecipeConfigLayer, RecipeSourceOption } from "@lando/sdk/schema";
import { defaultRoutes } from "./source-web.ts";

export const phpOption = {
  type: { kind: "enum", values: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] },
  default: "8.4",
  prompt: { message: "PHP version" },
} as const satisfies RecipeSourceOption;

export const composerOption = {
  type: { kind: "enum", values: ["2", "2.7.7"] },
  default: "2",
  prompt: { message: "Composer version" },
} as const satisfies RecipeSourceOption;

export const webrootOption = (webroot: string) =>
  ({
    type: { kind: "string", pattern: "^[A-Za-z0-9._/-]+$" },
    default: webroot,
    prompt: {
      message: "PHP webroot",
      validationMessage:
        "Webroot must be a path relative to the app root, such as web, or an absolute container path.",
    },
  }) as const satisfies RecipeSourceOption;

export const composerTool = {
  service: "appserver",
  description: "Run Composer inside the appserver service.",
  cmds: ["composer"],
} as const;

export const phpTool = {
  service: "appserver",
  description: "Run the PHP CLI inside the appserver service.",
  cmds: ["php"],
} as const;

export const phpAppserver = (framework: string) => ({
  type: "php:{{ recipe.php }}",
  primary: true,
  framework,
  webroot: "{{ recipe.webroot }}",
  composer: "{{ recipe.composer }}",
  dependsOn: ["database"],
});

export const drupalOptions = {
  php: phpOption,
  webserver: {
    type: { kind: "enum", values: ["apache", "nginx"] },
    default: "apache",
    prompt: { message: "Web server" },
  },
  database: {
    type: { kind: "enum", values: ["mariadb:11.4", "mysql:8.0", "postgres:16"] },
    default: "mariadb:11.4",
    prompt: { message: "Database" },
  },
  composer: composerOption,
  webroot: webrootOption("web"),
} as const satisfies Readonly<Record<string, RecipeSourceOption>>;

/** Separate additions avoid deleting Apache fields in the FPM branch. */
export const drupalWebVariants = [
  {
    when: '{{ eq(options.webserver, "apache") }}',
    config: { services: { appserver: { allowOverride: true, port: 80, routes: defaultRoutes } } },
  },
  {
    when: '{{ eq(options.webserver, "nginx") }}',
    config: {
      services: {
        appserver: { via: "fpm" },
        edge: {
          type: "nginx",
          backend: "appserver",
          webroot: "{{ recipe.webroot }}",
          routes: defaultRoutes,
        },
      },
    },
  },
] as const satisfies readonly RecipeConfigLayer[];
