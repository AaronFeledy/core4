import { describe, expect, it } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import type { RecipeOptionType, RecipeOptionValue } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { buildConfig } from "../../build.config.ts";
import {
  BUILTIN_RECIPE_DECOMPOSERS,
  builtinRecipeDecomposerIds,
  lookupRecipeDecomposer,
} from "../../src/recipes/builtin/decomposers.ts";
import { BUILTIN_RECIPE_SNAPSHOTS } from "../../src/recipes/builtin/snapshots.ts";

const ids = buildConfig.bundledRecipes.map(({ id }) => id);
const redactor = createStandaloneRedactor("secrets", { redactionTokens: [] });
const mistypedValueFor = (descriptor: RecipeOptionType): RecipeOptionValue =>
  descriptor.kind === "number" ? "not-a-number" : 0.5;

describe("bundled recipe decomposers", () => {
  it("ships one decomposer per source in shipping order", () => {
    expect(builtinRecipeDecomposerIds()).toEqual(ids);
    expect(BUILTIN_RECIPE_DECOMPOSERS.size).toBe(24);
    expect(lookupRecipeDecomposer("unshipped-recipe")).toBeUndefined();
  });
  it("keys every decomposer by its bundled producer and gives each distinct content identity", () => {
    const digests = new Set<string>();
    for (const id of ids) {
      const factory = lookupRecipeDecomposer(id);
      if (factory === undefined) throw new Error(`Missing ${id}`);
      const { producer } = factory({ redactor });
      expect(producer.recipeId).toBe(id);
      expect(producer.sourceKind).toBe("bundled");
      expect(producer.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      digests.add(producer.contentDigest);
    }
    expect(digests.size).toBe(24);
  });
  it("remediates each rejected option using its own descriptor", () => {
    for (const [id, snapshot] of BUILTIN_RECIPE_SNAPSHOTS) {
      const factory = lookupRecipeDecomposer(id);
      if (factory === undefined) throw new Error(`Missing ${id}`);
      const decomposer = factory({ redactor });
      for (const [name, descriptor] of Object.entries(snapshot.optionTypes)) {
        const result = Effect.runSync(
          Effect.result(
            decomposer.decompose({
              producer: decomposer.producer,
              options: { ...snapshot.defaults, [name]: mistypedValueFor(descriptor) },
              secrets: {},
            }),
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isSuccess(result)) throw new Error(`Accepted invalid ${id}.${name}`);
        expect(result.failure).toMatchObject({ reason: "option-type", path: `options.${name}` });
        switch (descriptor.kind) {
          case "boolean":
            expect(result.failure.remediation).toBe("Supply true or false.");
            break;
          case "enum":
            for (const value of descriptor.values)
              expect(result.failure.remediation).toContain(String(value));
            break;
          case "string":
            if (descriptor.pattern !== undefined)
              expect(result.failure.remediation).toContain(descriptor.pattern);
            break;
          case "number":
          case "array":
          case "optional":
            break;
          default:
            descriptor satisfies never;
        }
      }
    }
  });
});
