import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/core/schema";
import { AppPlanner, LandofileService } from "@lando/core/services";

import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { AppPlannerLive } from "@lando/engine/services/planner";
import { BUILTIN_RECIPE_DECOMPOSERS } from "../../src/recipes/builtin/decomposers.ts";
import { BUNDLED_RECIPES } from "../../src/recipes/bundled.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";
import { TestLandofileServiceLive as LandofileServiceLive } from "../_support/landofile-layer.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";
import { previewBuiltinRecipe } from "../_support/recipe-output.ts";

interface CanonicalAnswers {
  readonly name: string;
  readonly extras?: Record<string, string>;
}

const CANONICAL_ANSWERS: Readonly<Record<string, CanonicalAnswers>> = {
  "node-postgres": { name: "node-postgres-canon" },
  wordpress: { name: "wp-canon", extras: { php: "8.3", redis: "false" } },
  laravel: {
    name: "laravel-canon",
    extras: { php: "8.3", database: "postgres:16", worker: "true" },
  },
  symfony: { name: "symfony-canon", extras: { php: "8.3", database: "postgres:16" } },
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
  drupal: { name: "drupal-canon", extras: { php: "8.3", database: "mariadb:11.4" } },
  "drupal-cms": { name: "drupal-cms-canon", extras: { php: "8.3", database: "mariadb:11.4" } },
  fastapi: { name: "fastapi-canon" },
  rails: { name: "rails-canon" },
  jekyll: { name: "jekyll-canon" },
  hugo: { name: "hugo-canon" },
  eleventy: { name: "eleventy-canon" },
  empty: { name: "empty-canon" },
  "node-ts": { name: "node-ts-canon" },
  toolbox: { name: "toolbox-canon" },
  backdrop: { name: "backdrop-canon", extras: { php: "8.3", database: "mysql:8.0" } },
  joomla: { name: "joomla-canon", extras: { php: "8.3", database: "mysql:8.0" } },
  mean: { name: "mean-canon", extras: { node: "22", redis: "true" } },
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
  serviceLogSources: true,
  serviceHealth: "native" as const,
  hostReachability: "native" as const,
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native" as const,
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none" as const,
  serviceFileCopy: "none" as const,
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "native" as const,
  routeProvider: true,
  tlsCertificates: "lando" as const,
  rootless: true,
  privilegedServices: false,
  architectureEmulation: false,
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
      const manifestFiles = manifest.files ?? [];
      expect(manifestFiles.length, `[${recipeId}] manifest.files must be non-empty`).toBeGreaterThan(0);

      expect(BUILTIN_RECIPE_DECOMPOSERS.has(recipeId), `[${recipeId}] missing registered decomposer`).toBe(
        true,
      );
      const effectiveDests = [
        ".lando.yml",
        ...manifestFiles
          .map((file) => file.dest)
          .filter((dest) => dest !== ".lando.yml" && dest !== ".lando.ts"),
      ];

      await withTempCwd(async (dir) => {
        const result = await initApp({
          cwd: dir,
          full: false,
          recipe: recipeId,
          nonInteractive: true,
          answers,
          userDataRoot: join(dir, "lando-data"),
          postInitIO: { out: () => {}, err: () => {} },
        });
        expect(result.appName, `[${recipeId}] initApp.appName`).toBe(answersEntry.name);

        const preview = await previewBuiltinRecipe(recipeId, answersEntry.name, result.answers);
        expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toBe(preview.text);
        for (const dest of effectiveDests) {
          const path = join(result.directory, dest);
          const handle = Bun.file(path);
          const exists = await handle.exists();
          expect(exists, `[${recipeId}] expected generated file ${dest} at ${path}`).toBe(true);
          if (!exists) continue;
          expect(handle.size, `[${recipeId}] generated file ${dest} is empty at ${path}`).toBeGreaterThan(0);
        }

        await withScrubbedRecipeEnv(async () => {
          const landofile = await discoverFrom(result.directory);
          expect(landofile.name, `[${recipeId}] discovered landofile.name`).toBe(answersEntry.name);
          expect(landofile.recipe, `[${recipeId}] discovered landofile.recipe`).toMatchObject({
            id: recipeId,
            version: manifest.version,
            producer: manifest.snapshot?.identity,
          });

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
