import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";

import { initApp } from "../../src/cli/commands/init.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { BUILTIN_RECIPE_RENDERERS, builtinRecipeIds } from "../../src/recipes/builtin/registry.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-canonical-")));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const discoverFrom = async (cwd: string) => {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await Effect.runPromise(
      Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
        Effect.provide(LandofileServiceLive),
      ),
    );
  } finally {
    process.chdir(previousCwd);
  }
};

interface CanonicalCase {
  readonly recipe: string;
  readonly answers: Record<string, string>;
  readonly expectedServices: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly expectedTooling?: ReadonlyArray<string>;
}

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
      "fastapi",
      "rails",
      "jekyll",
      "hugo",
      "eleventy",
      "empty",
      "node-ts",
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
