import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { RecipeOptionType, RecipeOptionValue, RecipeSnapshot } from "@lando/sdk/schema";
import { Effect, Either } from "effect";

import { buildConfig } from "../../build.config.ts";
import { astroSnapshot } from "../../src/recipes/builtin/astro/snapshot.ts";
import { backdropSnapshot } from "../../src/recipes/builtin/backdrop/snapshot.ts";
import { BUILTIN_RECIPE_DECOMPOSERS, lookupRecipeDecomposer } from "../../src/recipes/builtin/decomposers.ts";
import { djangoSnapshot } from "../../src/recipes/builtin/django/snapshot.ts";
import { drupalCmsSnapshot } from "../../src/recipes/builtin/drupal-cms/snapshot.ts";
import { drupalSnapshot } from "../../src/recipes/builtin/drupal/snapshot.ts";
import { eleventySnapshot } from "../../src/recipes/builtin/eleventy/snapshot.ts";
import { emptySnapshot } from "../../src/recipes/builtin/empty/snapshot.ts";
import { fastapiSnapshot } from "../../src/recipes/builtin/fastapi/snapshot.ts";
import { hugoSnapshot } from "../../src/recipes/builtin/hugo/snapshot.ts";
import { jekyllSnapshot } from "../../src/recipes/builtin/jekyll/snapshot.ts";
import { joomlaSnapshot } from "../../src/recipes/builtin/joomla/snapshot.ts";
import { lampSnapshot } from "../../src/recipes/builtin/lamp/snapshot.ts";
import { laravelSnapshot } from "../../src/recipes/builtin/laravel/snapshot.ts";
import { lempSnapshot } from "../../src/recipes/builtin/lemp/snapshot.ts";
import { meanSnapshot } from "../../src/recipes/builtin/mean/snapshot.ts";
import { nextjsSnapshot } from "../../src/recipes/builtin/nextjs/snapshot.ts";
import { nodeApiSnapshot } from "../../src/recipes/builtin/node-api/snapshot.ts";
import { nodePostgresSnapshot } from "../../src/recipes/builtin/node-postgres/snapshot.ts";
import { nodeTsSnapshot } from "../../src/recipes/builtin/node-ts/snapshot.ts";
import { railsSnapshot } from "../../src/recipes/builtin/rails/snapshot.ts";
import { sveltekitSnapshot } from "../../src/recipes/builtin/sveltekit/snapshot.ts";
import { symfonySnapshot } from "../../src/recipes/builtin/symfony/snapshot.ts";
import { toolboxSnapshot } from "../../src/recipes/builtin/toolbox/snapshot.ts";
import { wordpressSnapshot } from "../../src/recipes/builtin/wordpress/snapshot.ts";

/**
 * Per-recipe suites pin individual decomposers; this suite checks the complete
 * shipping set for snapshots, READMEs, scaffold output, auxiliary inventories,
 * and default/nondefault or no-option behavior through the real decomposers.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BUNDLED_IDS = buildConfig.bundledRecipes.map((entry) => entry.id);
const redactor = createStandaloneRedactor("secrets", { redactionTokens: [] });

/** A second, still-valid value for a declared descriptor, or undefined when it has no alternative. */
const alternateValueFor = (
  descriptor: RecipeOptionType,
  current: RecipeOptionValue | undefined,
): RecipeOptionValue | undefined => {
  if (descriptor.kind === "boolean") return current !== true;
  if (descriptor.kind === "enum") return descriptor.values.find((value) => value !== current);
  return undefined;
};

const decomposerFor = (recipeId: string) => {
  const factory = lookupRecipeDecomposer(recipeId);
  if (factory === undefined) throw new Error(`no decomposer registered for "${recipeId}"`);
  return factory({ redactor });
};

const SNAPSHOTS: Readonly<Record<string, RecipeSnapshot>> = {
  "node-postgres": nodePostgresSnapshot,
  wordpress: wordpressSnapshot,
  laravel: laravelSnapshot,
  symfony: symfonySnapshot,
  lamp: lampSnapshot,
  backdrop: backdropSnapshot,
  joomla: joomlaSnapshot,
  lemp: lempSnapshot,
  "node-api": nodeApiSnapshot,
  mean: meanSnapshot,
  astro: astroSnapshot,
  sveltekit: sveltekitSnapshot,
  nextjs: nextjsSnapshot,
  django: djangoSnapshot,
  drupal: drupalSnapshot,
  "drupal-cms": drupalCmsSnapshot,
  fastapi: fastapiSnapshot,
  rails: railsSnapshot,
  jekyll: jekyllSnapshot,
  hugo: hugoSnapshot,
  eleventy: eleventySnapshot,
  empty: emptySnapshot,
  "node-ts": nodeTsSnapshot,
  toolbox: toolboxSnapshot,
};

const snapshotFor = (recipeId: string): RecipeSnapshot => {
  const snapshot = SNAPSHOTS[recipeId];
  if (snapshot === undefined) throw new Error(`no published snapshot for "${recipeId}"`);
  return snapshot;
};

describe("bundled recipe conversion milestone", () => {
  it("ships exactly twenty-four bundled recipe ids", () => {
    expect(BUNDLED_IDS.length).toBe(24);
    expect(new Set(BUNDLED_IDS).size).toBe(24);
  });

  it("registers one decomposer per bundled id and none beyond the set", () => {
    for (const recipeId of BUNDLED_IDS) expect(lookupRecipeDecomposer(recipeId)).toBeDefined();
    expect([...BUILTIN_RECIPE_DECOMPOSERS.keys()].sort()).toEqual([...BUNDLED_IDS].sort());
  });

  it("publishes a current declarative snapshot with versioned bundled identity", () => {
    for (const recipeId of BUNDLED_IDS) {
      const snapshot = snapshotFor(recipeId);
      const producer = snapshot.identity;
      expect<unknown>({
        sourceKind: producer.sourceKind,
        recipeId: producer.recipeId,
      }).toEqual({ sourceKind: "bundled", recipeId });
      expect(producer.manifestVersion).toMatch(/^\d+\.\d+\.\d+/u);
      expect(producer.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect<unknown>(decomposerFor(recipeId).producer).toEqual(producer);
    }
  });

  it("declares an explicit auxiliary inventory for every recipe", () => {
    // An empty array is the explicit statement that a recipe ships no
    // auxiliary asset; an absent key would leave that unstated.
    for (const recipeId of BUNDLED_IDS) {
      const snapshot = snapshotFor(recipeId);
      expect(Array.isArray(snapshot.assets)).toBe(true);
      for (const asset of snapshot.assets) {
        expect(asset.dest.length).toBeGreaterThan(0);
        expect(asset.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      }
    }
  });

  it("ships an executable README and its generated scaffold output", () => {
    for (const recipeId of BUNDLED_IDS) {
      expect({
        recipeId,
        readme: existsSync(join(REPO_ROOT, "recipes", recipeId, "README.mdx")),
        scaffold: existsSync(join(REPO_ROOT, "recipes", recipeId, ".scaffold", "default.md")),
      }).toEqual({ recipeId, readme: true, scaffold: true });
    }
  });

  it("owns a per-recipe decomposer suite for every bundled id", () => {
    for (const recipeId of BUNDLED_IDS) {
      const suite = join(REPO_ROOT, "core", "test", "recipes", `${recipeId}.decomposer.test.ts`);
      expect({ recipeId, suite: existsSync(suite) }).toEqual({ recipeId, suite: true });
    }
  });

  it("decomposes every recipe from its published defaults", () => {
    for (const recipeId of BUNDLED_IDS) {
      const decomposer = decomposerFor(recipeId);
      const snapshot = snapshotFor(recipeId);
      const result = Effect.runSync(
        Effect.either(
          decomposer.decompose({
            producer: decomposer.producer,
            options: { ...snapshot.defaults },
            secrets: {},
          }),
        ),
      );
      expect({ recipeId, ok: Either.isRight(result) }).toEqual({ recipeId, ok: true });
      if (!Either.isRight(result)) continue;
      expect<unknown>(result.right.provenance.producer).toEqual(decomposer.producer);
      expect(result.right.fragment).toBeDefined();
    }
  });

  it("covers a nondefault answer, or explicit no-option behavior, for every recipe", () => {
    for (const recipeId of BUNDLED_IDS) {
      const decomposer = decomposerFor(recipeId);
      const snapshot = snapshotFor(recipeId);
      const defaults = { ...snapshot.defaults };
      const descriptors = Object.entries(snapshot.optionTypes);

      if (descriptors.length === 0) {
        // A zero-option recipe states that explicitly by rejecting any option
        // key it never declared, rather than silently ignoring it.
        const rejected = Effect.runSync(
          Effect.either(
            decomposer.decompose({
              producer: decomposer.producer,
              options: { "not-a-declared-option": "x" },
              secrets: {},
            }),
          ),
        );
        expect({ recipeId, rejected: Either.isLeft(rejected) }).toEqual({
          recipeId,
          rejected: true,
        });
        if (!Either.isLeft(rejected)) continue;
        expect<unknown>((rejected.left as { reason: string }).reason).toEqual("option-type");
        continue;
      }

      const nondefault = descriptors
        .map(([name, descriptor]) => {
          const alternate = alternateValueFor(descriptor, defaults[name]);
          return alternate === undefined ? undefined : ([name, alternate] as const);
        })
        .find((entry) => entry !== undefined);
      expect({ recipeId, hasNondefault: nondefault !== undefined }).toEqual({
        recipeId,
        hasNondefault: true,
      });
      if (nondefault === undefined) continue;

      const [name, value] = nondefault;
      const result = Effect.runSync(
        Effect.either(
          decomposer.decompose({
            producer: decomposer.producer,
            options: { ...defaults, [name]: value },
            secrets: {},
          }),
        ),
      );
      expect({ recipeId, ok: Either.isRight(result) }).toEqual({ recipeId, ok: true });
      if (!Either.isRight(result)) continue;
      expect<unknown>(result.right.provenance.options[name]).toEqual(value);
    }
  });
});
