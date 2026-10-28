import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { MEAN_PACKAGE_JSON_TEMPLATE, MEAN_SERVER_JS } from "../../src/recipes/builtin/mean/scaffold.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
const {
  decomposer: meanDecomposer,
  defaults: meanDefaults,
  producer: meanProducer,
  snapshot: meanSnapshot,
  contentDigest: MEAN_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("mean");
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { recipeAssetDigest } from "../../src/recipes/builtin/snapshot-asset.ts";
import { renderAuxiliaryScaffold } from "../../src/recipes/init-pipeline/files.ts";

const defaults = { ...meanDefaults };
const validInput: RecipeDecomposeInput = { producer: meanProducer, options: defaults, secrets: {} };
const decomposer = meanDecomposer({ redactor: createStandaloneRedactor("secrets") });
const decompose = (options: RecipeDecomposeInput["options"]) =>
  Effect.runSync(decomposer.decompose({ producer: meanProducer, options, secrets: {} }));
const authoringOf = (options: RecipeDecomposeInput["options"]) => {
  const { recipe: _recipe, ...authoring } = decompose(options).fragment;
  return authoring;
};

describe("mean decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "mean",
        factory: meanDecomposer,
        producer: meanProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, redis: "true" } },
        missingRecipeInput: { ...validInput, producer: { ...meanProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    const provenance = { id: "mean", version: "0.1.0", producer: meanProducer, options: defaults };
    expect(result.provenance).toEqual(provenance);
    expect(result.fragment).toEqual({
      runtime: 4,
      recipe: provenance,
      services: {
        api: {
          type: "node:{{ recipe.node }}",
          primary: true,
          port: 3000,
          command: "npm install --no-audit --no-fund && exec node server.js",
          environment: {
            NODE_ENV: "development",
            PORT: 3000,
            MONGO_URL:
              "mongodb://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}?authSource=admin",
          },
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "mongodb" },
      },
      tooling: {
        npm: { service: "api", description: "Run npm inside the api service.", cmds: ["npm"] },
        node: { service: "api", description: "Run Node inside the api service.", cmds: ["node"] },
      },
    });
  });

  test("appends the cache when nondefault options enable Redis", () => {
    const services = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      authoringOf({ node: "22", redis: true }).services,
    );
    expect(services.api).toMatchObject({
      environment: { REDIS_URL: "redis://cache:6379" },
      dependsOn: [{ service: "database" }, { service: "cache" }],
    });
    expect(services.cache).toMatchObject({ type: "redis" });
    expect(Object.keys(services)).toEqual(["api", "database", "cache"]);
  });

  test.each([
    { options: { ...defaults, node: "18" }, path: "options.node" },
    { options: { ...defaults, node: 22 }, path: "options.node" },
    { options: { ...defaults, redis: "true" }, path: "options.redis" },
    { options: { ...defaults, redis: "yes" }, path: "options.redis" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.result(decomposer.decompose({ producer: meanProducer, options, secrets: {} })),
    );
    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) {
      expect(failure.failure.reason).toBe("option-type");
      expect(failure.failure.path).toBe(path);
      expect(failure.failure.remediation).toBeString();
    }
  });

  test("publishes the auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/package.json.tmpl", dest: "package.json", template: true },
      { src: "templates/server.js.tmpl", dest: "server.js", template: true },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([
      { dest: "package.json", digest: recipeAssetDigest(MEAN_PACKAGE_JSON_TEMPLATE), template: true },
      { dest: "server.js", digest: recipeAssetDigest(MEAN_SERVER_JS), template: true },
    ]);
    expect(recipeAssetDigest(MEAN_PACKAGE_JSON_TEMPLATE)).toBe(
      "sha256:494be86d9ac5c547086e9ad5a231f926852ada98db9dcd88412765bf0ca92cdb",
    );
    expect(recipeAssetDigest(MEAN_SERVER_JS)).toBe(
      "sha256:540dfe82273a2308d18fe047c50788e950147abe7b970fab40d1738df4a9c9a9",
    );
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", async () => {
    expect(await recompiledBundledDigest(manifest)).toBe(MEAN_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(meanSnapshot);
    expect(meanSnapshot.identity.contentDigest).toBe(MEAN_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(MEAN_CONTENT_DIGEST).toBe(meanSnapshot.identity.contentDigest);
  });

  test.each([defaults, { node: "22", redis: false }, { node: "lts", redis: true }])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Result.getOrThrow(renderRecipeSnapshot(meanSnapshot, options))).toEqual(authoringOf(options));
    },
  );

  test("preserves neutral scaffold bytes when rendering the probe app", async () => {
    const source = bundledRecipeContentSource("mean");
    const packageJson = await source({ src: "templates/package.json", dest: "package.json" });
    expect(packageJson).toBe(MEAN_PACKAGE_JSON_TEMPLATE);
    if (packageJson === undefined) throw new Error("Missing package scaffold");
    expect(renderAuxiliaryScaffold(packageJson, "probe")).toBe(
      MEAN_PACKAGE_JSON_TEMPLATE.replaceAll("{{ app.name }}", "probe"),
    );
    expect(await source({ src: "templates/server.js", dest: "server.js" })).toBe(MEAN_SERVER_JS);
  });
});
