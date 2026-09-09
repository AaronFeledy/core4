import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { meanDecomposer } from "../../src/recipes/builtin/mean/decomposer.ts";
import { meanRecipeYaml } from "../../src/recipes/builtin/mean/manifest.ts";
import { meanRenderer } from "../../src/recipes/builtin/mean/render.ts";
import { MEAN_PACKAGE_JSON_TEMPLATE, MEAN_SERVER_JS } from "../../src/recipes/builtin/mean/scaffold.ts";
import {
  MEAN_CONTENT_DIGEST,
  meanDefaults,
  meanProducer,
  meanSnapshot,
} from "../../src/recipes/builtin/mean/snapshot.ts";
import { recipeAssetDigest } from "../../src/recipes/builtin/snapshot-asset.ts";

const defaults = { ...meanDefaults };
const validInput: RecipeDecomposeInput = { producer: meanProducer, options: defaults, secrets: {} };
const decomposer = meanDecomposer({ redactor: createStandaloneRedactor("secrets") });
const decompose = (options: RecipeDecomposeInput["options"]) =>
  Effect.runSync(decomposer.decompose({ producer: meanProducer, options, secrets: {} }));
const authoringOf = (options: RecipeDecomposeInput["options"]) => {
  const { recipe: _recipe, ...authoring } = decompose(options).fragment;
  return authoring;
};
const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(meanRecipeYaml));

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
          port: 3000,
          environment: {
            NODE_ENV: "development",
            PORT: 3000,
            MONGO_URL: "mongodb://lando:lando@database:27017/{{ app.name }}?authSource=admin",
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
    const { services } = authoringOf({ node: "22", redis: true });
    expect(services.api.environment.REDIS_URL).toBe("redis://cache:6379");
    expect(services.api.dependsOn).toEqual(["database", "cache"]);
    expect(services.cache?.type).toBe("redis");
    expect(Object.keys(services)).toEqual(["api", "database", "cache"]);
  });

  test.each([
    { options: { ...defaults, node: "18" }, path: "options.node" },
    { options: { ...defaults, node: 22 }, path: "options.node" },
    { options: { ...defaults, redis: "true" }, path: "options.redis" },
    { options: { ...defaults, redis: "yes" }, path: "options.redis" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(decomposer.decompose({ producer: meanProducer, options, secrets: {} })),
    );
    expect(Either.isLeft(failure)).toBe(true);
    if (Either.isLeft(failure)) {
      expect(failure.left.reason).toBe("option-type");
      expect(failure.left.path).toBe(path);
      expect(failure.left.remediation).toBeString();
    }
  });

  test("publishes the auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
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
      "sha256:ad6025fbbae9fe0b72e6170de266435baea8eea56067c3adf9bf70a55c112187",
    );
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(MEAN_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(meanSnapshot);
    expect(meanSnapshot.identity.contentDigest).toBe(MEAN_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(MEAN_CONTENT_DIGEST).toBe(
      "sha256:cac690f4c0552c0d605f52f4b0cf43fc630c6c3d1ea1280711374508223b0798",
    );
  });

  test.each([defaults, { node: "22", redis: false }, { node: "lts", redis: true }])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(meanSnapshot, options))).toEqual(authoringOf(options));
    },
  );

  test("preserves renderer asset bytes when rendering the probe app", () => {
    const files = meanRenderer.render({ appName: "probe", answers: {} });
    expect(files.get("package.json")).toBe(MEAN_PACKAGE_JSON_TEMPLATE.replaceAll("{{ app.name }}", "probe"));
    expect(files.get("server.js")).toBe(MEAN_SERVER_JS);
  });
});
