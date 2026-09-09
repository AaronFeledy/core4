import { describe, expect, it } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { RecipeOptionType, RecipeOptionValue, RecipeSnapshot } from "@lando/sdk/schema";
import { Effect, Either } from "effect";

import { astroSnapshot } from "../../src/recipes/builtin/astro/snapshot.ts";
import { backdropSnapshot } from "../../src/recipes/builtin/backdrop/snapshot.ts";
import {
  BUILTIN_RECIPE_DECOMPOSERS,
  builtinRecipeDecomposerIds,
  lookupRecipeDecomposer,
} from "../../src/recipes/builtin/decomposers.ts";
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
import { builtinRecipeIds } from "../../src/recipes/builtin/registry.ts";
import { sveltekitSnapshot } from "../../src/recipes/builtin/sveltekit/snapshot.ts";
import { symfonySnapshot } from "../../src/recipes/builtin/symfony/snapshot.ts";
import { toolboxSnapshot } from "../../src/recipes/builtin/toolbox/snapshot.ts";
import { wordpressSnapshot } from "../../src/recipes/builtin/wordpress/snapshot.ts";

const CONVERTED_RECIPE_IDS = [
  "lamp",
  "lemp",
  "wordpress",
  "laravel",
  "symfony",
  "drupal",
  "drupal-cms",
  "backdrop",
  "joomla",
  "node-postgres",
  "node-api",
  "mean",
  "node-ts",
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
  "toolbox",
] as const;

const SNAPSHOTS: Readonly<Record<(typeof CONVERTED_RECIPE_IDS)[number], RecipeSnapshot>> = {
  lamp: lampSnapshot,
  lemp: lempSnapshot,
  wordpress: wordpressSnapshot,
  laravel: laravelSnapshot,
  symfony: symfonySnapshot,
  drupal: drupalSnapshot,
  "drupal-cms": drupalCmsSnapshot,
  backdrop: backdropSnapshot,
  joomla: joomlaSnapshot,
  "node-postgres": nodePostgresSnapshot,
  "node-api": nodeApiSnapshot,
  mean: meanSnapshot,
  "node-ts": nodeTsSnapshot,
  astro: astroSnapshot,
  sveltekit: sveltekitSnapshot,
  nextjs: nextjsSnapshot,
  django: djangoSnapshot,
  fastapi: fastapiSnapshot,
  rails: railsSnapshot,
  jekyll: jekyllSnapshot,
  hugo: hugoSnapshot,
  eleventy: eleventySnapshot,
  empty: emptySnapshot,
  toolbox: toolboxSnapshot,
};

/** A value of the wrong shape for the descriptor, so every declared constraint rejects it. */
const mistypedValueFor = (descriptor: RecipeOptionType): RecipeOptionValue =>
  descriptor.kind === "number" ? "not-a-number" : 0.5;

const redactor = createStandaloneRedactor("secrets", { redactionTokens: [] });

describe("bundled recipe decomposers", () => {
  it("ships one decomposer per converted recipe", () => {
    expect(builtinRecipeDecomposerIds()).toEqual([...CONVERTED_RECIPE_IDS]);
    expect(BUILTIN_RECIPE_DECOMPOSERS.size).toBe(CONVERTED_RECIPE_IDS.length);
  });

  it("keys every decomposer by the recipe id its producer records", () => {
    for (const recipeId of CONVERTED_RECIPE_IDS) {
      const factory = lookupRecipeDecomposer(recipeId);
      expect(factory).toBeDefined();
      const decomposer = factory?.({ redactor });
      expect<unknown>(decomposer?.producer.recipeId).toEqual(recipeId);
      expect<unknown>(decomposer?.producer.sourceKind).toEqual("bundled");
    }
  });

  it("records a distinct versioned content digest for every recipe", () => {
    const digests = CONVERTED_RECIPE_IDS.map(
      (recipeId) => lookupRecipeDecomposer(recipeId)?.({ redactor }).producer.contentDigest,
    );
    expect(new Set(digests).size).toBe(CONVERTED_RECIPE_IDS.length);
    for (const digest of digests) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("ships a decomposer for every bundled renderer and none for an unshipped id", () => {
    // Bundled renderer ids equal decomposer ids; looking up an id absent from
    // the bundled registry returns undefined.
    expect<unknown>([...builtinRecipeIds()].sort()).toEqual([...CONVERTED_RECIPE_IDS].sort());
    const unshipped = "unshipped-recipe";
    expect(builtinRecipeIds()).not.toContain(unshipped);
    expect(lookupRecipeDecomposer(unshipped)).toBeUndefined();
  });

  it("remediates a rejected option in the shape its descriptor declares", () => {
    // Given every declared option mistyped in turn; when decomposed; then the
    // remediation names that option's own shape instead of a family-wide guess.
    for (const recipeId of CONVERTED_RECIPE_IDS) {
      const decomposer = lookupRecipeDecomposer(recipeId)?.({ redactor });
      expect(decomposer).toBeDefined();
      if (decomposer === undefined) continue;
      const snapshot = SNAPSHOTS[recipeId];
      for (const [name, descriptor] of Object.entries(snapshot.optionTypes)) {
        const result = Effect.runSync(
          Effect.either(
            decomposer.decompose({
              producer: decomposer.producer,
              options: { ...snapshot.defaults, [name]: mistypedValueFor(descriptor) },
              secrets: {},
            }),
          ),
        );
        expect(Either.isLeft(result)).toBe(true);
        if (!Either.isLeft(result)) continue;
        const failure = result.left as { reason: string; path?: string; remediation: string };
        expect<unknown>({ reason: failure.reason, path: failure.path }).toEqual({
          reason: "option-type",
          path: `options.${name}`,
        });
        const label = `${recipeId}.${name}`;
        if (descriptor.kind === "boolean") {
          expect(`${label}: ${failure.remediation}`).toBe(`${label}: Supply true or false.`);
        } else if (descriptor.kind === "enum") {
          for (const value of descriptor.values) {
            expect(`${label}: ${failure.remediation}`).toContain(value);
          }
        } else if (descriptor.kind === "string" && descriptor.pattern !== undefined) {
          expect(`${label}: ${failure.remediation}`).toContain(descriptor.pattern);
        }
      }
    }
  });
});
