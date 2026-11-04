import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

test("bundled generation has no bootstrap dependency on its own generated consumers", async () => {
  const result = await Bun.build({
    entrypoints: [resolve(root, "scripts/build-bundled-recipes.ts")],
    target: "bun",
    packages: "external",
    plugins: [
      {
        name: "reject-generated-recipe-inputs",
        setup(build) {
          build.onResolve(
            { filter: /(?:^|\/)bundled(?:\.ts)?$|generated\/(?:catalog|bundled-recipes)(?:\.ts)?$/u },
            (args) => {
              throw new Error(`Recipe generator depends on generated consumer ${args.path}`);
            },
          );
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  expect(result.outputs.length).toBeGreaterThan(0);
});

test("cold recipe metadata bundles without loading SDK, compiler or provider modules", async () => {
  const result = await Bun.build({
    entrypoints: [resolve(root, "core/src/recipes/catalog.ts")],
    target: "bun",
    plugins: [
      {
        name: "reject-warm-catalog-dependencies",
        setup(build) {
          build.onResolve(
            {
              filter:
                /^(?:effect(?:\/|$)|@lando\/(?:sdk|engine|provider-))|(?:compiled-source|source-catalog|compiled-decomposer)(?:\.ts)?$/u,
            },
            (args) => {
              throw new Error(`Cold recipe catalog loads warm dependency ${args.path}`);
            },
          );
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  expect(result.outputs.length).toBeGreaterThan(0);
});
