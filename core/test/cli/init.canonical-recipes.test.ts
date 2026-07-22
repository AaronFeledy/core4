import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { ServiceName } from "@lando/core/schema";

import { initApp } from "../../src/cli/commands/init.ts";
import { BUILTIN_RECIPE_RENDERERS, builtinRecipeIds } from "../../src/recipes/builtin/registry.ts";
import { discoverFrom, withTempCwd } from "./support/init-recipe-harness.ts";

interface CanonicalCase {
  readonly recipe: string;
  readonly answers: Record<string, string>;
  readonly expectedServices: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly expectedTooling?: ReadonlyArray<string>;
}

// allow: SIZE_OK — this declarative recipe matrix is exercised by one shared harness.
const CANONICAL_CASES: ReadonlyArray<CanonicalCase> = [
  {
    recipe: "wordpress",
    answers: { name: "wp-app", php: "8.3", redis: "false" },
    expectedServices: [
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "mariadb" },
    ],
    expectedTooling: ["wp", "composer"],
  },
  {
    recipe: "laravel",
    answers: { name: "laravel-app", php: "8.3", database: "postgres", worker: "true" },
    expectedServices: [
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "postgres" },
      { name: "cache", type: "redis" },
      { name: "worker", type: "php:8.3" },
    ],
    expectedTooling: ["artisan", "composer", "npm"],
  },
  {
    recipe: "symfony",
    answers: { name: "symfony-app", php: "8.3", database: "postgres" },
    expectedServices: [
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "postgres" },
      { name: "cache", type: "redis" },
    ],
    expectedTooling: ["console", "composer"],
  },
  {
    recipe: "lamp",
    answers: { name: "lamp-app", php: "8.3" },
    expectedServices: [
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "mariadb" },
    ],
    expectedTooling: ["composer", "php"],
  },
  {
    recipe: "lemp",
    answers: { name: "lemp-app", php: "8.3" },
    expectedServices: [
      { name: "web", type: "nginx" },
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "mariadb" },
    ],
    expectedTooling: ["composer", "php"],
  },
  {
    recipe: "drupal",
    answers: { name: "drupal-app", php: "8.3", database: "mariadb" },
    expectedServices: [
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "mariadb" },
    ],
    expectedTooling: ["drush", "composer", "drupal-scaffold"],
  },
  {
    recipe: "drupal-cms",
    answers: { name: "drupal-cms-app", php: "8.3", database: "mariadb" },
    expectedServices: [
      { name: "appserver", type: "php:8.3" },
      { name: "database", type: "mariadb" },
    ],
    expectedTooling: ["drush", "composer"],
  },
  {
    recipe: "node-api",
    answers: { name: "node-api-app", node: "lts", framework: "fastify", database: "postgres" },
    expectedServices: [
      { name: "api", type: "node:lts" },
      { name: "database", type: "postgres" },
    ],
    expectedTooling: ["npm", "node"],
  },
  {
    recipe: "astro",
    answers: { name: "astro-app", node: "lts", database: "none" },
    expectedServices: [{ name: "web", type: "node:lts" }],
    expectedTooling: ["astro", "npm"],
  },
  {
    recipe: "sveltekit",
    answers: { name: "svelte-app", node: "lts", adapter: "node", database: "none" },
    expectedServices: [{ name: "web", type: "node:lts" }],
    expectedTooling: ["svelte", "npm"],
  },
  {
    recipe: "nextjs",
    answers: { name: "nextjs-app", node: "lts", database: "postgres", auth: "none" },
    expectedServices: [
      { name: "web", type: "node:lts" },
      { name: "database", type: "postgres" },
    ],
    expectedTooling: ["next", "npm"],
  },
  {
    recipe: "django",
    answers: { name: "django-app", celery: "true" },
    expectedServices: [
      { name: "web", type: "python:3.12" },
      { name: "database", type: "postgres" },
      { name: "cache", type: "redis" },
      { name: "worker", type: "python:3.12" },
    ],
    expectedTooling: ["django", "pip"],
  },
  {
    recipe: "fastapi",
    answers: { name: "fastapi-app" },
    expectedServices: [
      { name: "web", type: "python:3.12" },
      { name: "database", type: "postgres" },
      { name: "cache", type: "redis" },
    ],
    expectedTooling: ["uvicorn", "pip"],
  },
  {
    recipe: "rails",
    answers: { name: "rails-app" },
    expectedServices: [
      { name: "web", type: "ruby:3.3" },
      { name: "database", type: "postgres" },
      { name: "cache", type: "redis" },
    ],
    expectedTooling: ["rails", "bundle"],
  },
  {
    recipe: "jekyll",
    answers: { name: "jekyll-app" },
    expectedServices: [
      { name: "builder", type: "ruby:3.3" },
      { name: "web", type: "static:nginx" },
    ],
    expectedTooling: ["jekyll", "bundle"],
  },
  {
    recipe: "hugo",
    answers: { name: "hugo-app" },
    expectedServices: [
      { name: "builder", type: "node:lts" },
      { name: "web", type: "static:nginx" },
    ],
    expectedTooling: ["hugo", "npm"],
  },
  {
    recipe: "eleventy",
    answers: { name: "eleventy-app" },
    expectedServices: [
      { name: "builder", type: "node:lts" },
      { name: "web", type: "static:nginx" },
    ],
    expectedTooling: ["eleventy", "npm"],
  },
  {
    recipe: "empty",
    answers: { name: "empty-app" },
    expectedServices: [],
  },
];

describe("BUILTIN_RECIPE_RENDERERS — bundled set", () => {
  test("contains every shipped bundled recipe id", () => {
    const ids = builtinRecipeIds();
    const required = [
      "node-postgres",
      "wordpress",
      "laravel",
      "symfony",
      "lamp",
      "lemp",
      "node-api",
      "astro",
      "sveltekit",
      "nextjs",
      "django",
      "drupal",
      "drupal-cms",
      "fastapi",
      "rails",
      "jekyll",
      "hugo",
      "eleventy",
      "empty",
      "node-ts",
      "toolbox",
    ];
    expect([...ids].sort()).toEqual([...required].sort());
    for (const id of required) {
      expect(BUILTIN_RECIPE_RENDERERS.has(id)).toBe(true);
    }
  });
});

describe("lando init — canonical common-stack recipes", () => {
  for (const canonical of CANONICAL_CASES) {
    test(`renders the ${canonical.recipe} recipe with canonical answers`, async () => {
      await withTempCwd(async (dir) => {
        const result = await initApp({
          cwd: dir,
          full: false,
          recipe: canonical.recipe,
          nonInteractive: true,
          answers: canonical.answers,
          postInitIO: { out: () => {}, err: () => {} },
        });
        expect(result.appName).toBe(canonical.answers.name as string);
        expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(true);

        const landofile = await discoverFrom(result.directory);
        expect(landofile.name).toBe(canonical.answers.name);
        expect(landofile.recipe).toBe(canonical.recipe);

        const services = landofile.services ?? {};
        const actualServiceNames = Object.keys(services).sort();
        const expectedServiceNames = canonical.expectedServices.map((s) => s.name).sort();
        expect(actualServiceNames).toEqual(expectedServiceNames);
        for (const expected of canonical.expectedServices) {
          const service = services[ServiceName.make(expected.name)];
          expect(service).toBeDefined();
          expect(service?.type).toBe(expected.type);
        }

        if (canonical.expectedTooling !== undefined) {
          const tooling = landofile.tooling ?? {};
          const actualToolingIds = Object.keys(tooling).sort();
          const expectedToolingIds = [...canonical.expectedTooling].sort();
          expect(actualToolingIds).toEqual(expectedToolingIds);
        }
      });
    });
  }
});

describe("lando init — managed-file ownership markers (US-353)", () => {
  test("node-postgres scaffold carries format-correct ownership markers and a ledger", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-postgres",
        nonInteractive: true,
        yes: true,
        answers: { name: "marker-app" },
        userDataRoot: join(dir, "lando-data"),
        postInitIO: { out: () => {}, err: () => {} },
      });

      const landofile = await Bun.file(join(result.directory, ".lando.yml")).text();
      expect(landofile.split("\n")[0]).toBe(
        "# lando-generated:node-postgres:.lando.yml — managed by Lando; delete this line to adopt this file.",
      );

      const packageJson = JSON.parse(await Bun.file(join(result.directory, "package.json")).text());
      expect(packageJson["x-lando-generated"]).toBe("node-postgres:package.json");
      expect(packageJson.name).toBe("marker-app");

      const serverJs = await Bun.file(join(result.directory, "server.js")).text();
      expect(serverJs.split("\n")[0]).toBe(
        "// lando-generated:node-postgres:server.js — managed by Lando; delete this line to adopt this file.",
      );

      const ledgerDir = (await readdir(join(dir, "lando-data", "managed-files")))[0];
      const ledger = JSON.parse(
        await Bun.file(join(dir, "lando-data", "managed-files", ledgerDir ?? "", "ledger.json")).text(),
      );
      const owners = (ledger.data.entries as Array<{ owner: string; format: string }>).map(
        (entry) => entry.format,
      );
      expect(owners.sort()).toEqual(["javascript", "json", "landofile"]);
    });
  });
});
