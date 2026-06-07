import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/core/schema";
import { AppPlanner, LandofileService } from "@lando/core/services";

import { initApp } from "../../src/cli/commands/init.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { BUILTIN_RECIPE_RENDERERS } from "../../src/recipes/builtin/registry.ts";
import { BUNDLED_RECIPES } from "../../src/recipes/bundled.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

interface CanonicalAnswers {
  readonly name: string;
  readonly extras?: Record<string, string>;
}

const CANONICAL_ANSWERS: Readonly<Record<string, CanonicalAnswers>> = {
  "node-postgres": { name: "node-postgres-canon" },
  wordpress: { name: "wp-canon", extras: { php: "8.3", redis: "false" } },
  laravel: {
    name: "laravel-canon",
    extras: { php: "8.3", database: "postgres", worker: "true" },
  },
  symfony: { name: "symfony-canon", extras: { php: "8.3", database: "postgres" } },
  lamp: { name: "lamp-canon", extras: { php: "8.3" } },
  lemp: { name: "lemp-canon", extras: { php: "8.3" } },
  "node-api": {
    name: "node-api-canon",
    extras: { node: "lts", framework: "fastify", database: "postgres" },
  },
  astro: { name: "astro-canon", extras: { node: "lts", database: "none" } },
  sveltekit: {
    name: "sveltekit-canon",
    extras: { node: "lts", adapter: "node", database: "none" },
  },
  nextjs: {
    name: "nextjs-canon",
    extras: { node: "lts", database: "postgres", auth: "none" },
  },
  django: { name: "django-canon", extras: { celery: "true" } },
  drupal: { name: "drupal-canon", extras: { php: "8.3", database: "mariadb" } },
  "drupal-cms": { name: "drupal-cms-canon", extras: { php: "8.3", database: "mariadb" } },
  fastapi: { name: "fastapi-canon" },
  rails: { name: "rails-canon" },
  jekyll: { name: "jekyll-canon" },
  hugo: { name: "hugo-canon" },
  eleventy: { name: "eleventy-canon" },
  empty: { name: "empty-canon" },
  "node-ts": { name: "node-ts-canon" },
};

const buildAnswers = (entry: CanonicalAnswers): Record<string, string> => ({
  name: entry.name,
  ...(entry.extras ?? {}),
});

const providerCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native" as const,
  hostReachability: "native" as const,
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native" as const,
  copyMounts: true,
  copyOnWriteAppRoot: false,
  hostPortPublish: "native" as const,
  routeProvider: true,
  tlsCertificates: "lando" as const,
  rootless: true,
  privilegedServices: false,
  composeSpec: "native" as const,
  providerExtensions: ["compose"],
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-recipe-matrix-")));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    // Restore cwd FIRST so a chdir failure cannot block temp-dir cleanup.
    try {
      process.chdir(previousCwd);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

const discoverFrom = async (cwd: string): Promise<LandofileShape> => {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await Effect.runPromise(
      Effect.flatMap(LandofileService, (service) => service.discover).pipe(
        Effect.provide(LandofileServiceLive),
      ),
    );
  } finally {
    process.chdir(previousCwd);
  }
};

const planLandofile = (landofile: LandofileShape) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

const DETERMINISTIC_RECIPE_ENV_KEYS = ["LANDO_NODE_VERSION", "NODE_ENV"] as const;

const withScrubbedRecipeEnv = async <T>(run: () => Promise<T>): Promise<T> => {
  const scrubbed = DETERMINISTIC_RECIPE_ENV_KEYS;
  const previous: Record<string, string | undefined> = {};
  for (const key of scrubbed) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await run();
  } finally {
    for (const key of scrubbed) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe("recipe layer — every bundled recipe parses, renders, discovers, and plans", () => {
  test("CANONICAL_ANSWERS covers every BUNDLED_RECIPES entry", () => {
    const missing = BUNDLED_RECIPES.filter((entry) => CANONICAL_ANSWERS[entry.id] === undefined).map(
      (entry) => entry.id,
    );
    expect(missing).toEqual([]);
  });

  for (const recipe of BUNDLED_RECIPES) {
    const recipeId = recipe.id;
    const answersEntry = CANONICAL_ANSWERS[recipeId];
    if (answersEntry === undefined) continue;

    test(`bundled recipe ${recipeId}: parse + render + discover + plan`, async () => {
      const answers = buildAnswers(answersEntry);

      const manifest = await Effect.runPromise(parseRecipe(recipe.source, recipe.manifestYaml));
      expect(manifest.id, `[${recipeId}] manifest.id mismatch`).toBe(recipeId);
      expect(manifest.files.length, `[${recipeId}] manifest.files must be non-empty`).toBeGreaterThan(0);

      const renderer = BUILTIN_RECIPE_RENDERERS.get(recipeId);
      expect(renderer, `[${recipeId}] missing registered renderer`).toBeDefined();
      if (renderer === undefined) return;

      const rendered = renderer.render({ appName: answersEntry.name, answers });
      for (const file of manifest.files) {
        expect(
          rendered.has(file.dest),
          `[${recipeId}] renderer did not emit manifest file ${file.dest}`,
        ).toBe(true);
        const content = rendered.get(file.dest);
        expect(
          typeof content === "string" && content.length > 0,
          `[${recipeId}] renderer emitted empty content for ${file.dest} (rendered map)`,
        ).toBe(true);
      }

      await withTempCwd(async (dir) => {
        const result = await initApp({
          cwd: dir,
          full: false,
          recipe: recipeId,
          nonInteractive: true,
          answers,
          postInitIO: { out: () => {}, err: () => {} },
        });
        expect(result.appName, `[${recipeId}] initApp.appName`).toBe(answersEntry.name);

        for (const file of manifest.files) {
          const path = join(result.directory, file.dest);
          const handle = Bun.file(path);
          const exists = await handle.exists();
          expect(exists, `[${recipeId}] expected generated file ${file.dest} at ${path}`).toBe(true);
          if (!exists) continue;
          expect(
            handle.size,
            `[${recipeId}] generated file ${file.dest} is empty at ${path}`,
          ).toBeGreaterThan(0);
        }

        await withScrubbedRecipeEnv(async () => {
          const landofile = await discoverFrom(result.directory);
          expect(landofile.name, `[${recipeId}] discovered landofile.name`).toBe(answersEntry.name);
          const recipeFieldOmitAllowlist = new Set(["node-postgres", "node-ts"]);
          if (recipeFieldOmitAllowlist.has(recipeId)) {
            if (landofile.recipe !== undefined) {
              expect(landofile.recipe, `[${recipeId}] discovered landofile.recipe (when present)`).toBe(
                recipeId,
              );
            }
          } else {
            expect(landofile.recipe, `[${recipeId}] discovered landofile.recipe`).toBe(recipeId);
          }

          const appPlan = await planLandofile(landofile);
          expect(appPlan.name, `[${recipeId}] AppPlanner.plan returned wrong app name`).toBe(
            answersEntry.name,
          );
          expect(appPlan.services, `[${recipeId}] AppPlanner.plan returned no services record`).toBeDefined();
        });
      });
    });
  }
});
