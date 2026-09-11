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
import { nodePostgresDecomposer } from "../../src/recipes/builtin/node-postgres/decomposer.ts";
import { nodePostgresRecipeYaml } from "../../src/recipes/builtin/node-postgres/manifest.ts";
import {
  NODE_POSTGRES_PACKAGE_JSON_TEMPLATE,
  NODE_POSTGRES_SERVER_JS,
} from "../../src/recipes/builtin/node-postgres/scaffold.ts";
import {
  NODE_POSTGRES_CONTENT_DIGEST,
  nodePostgresDefaults,
  nodePostgresProducer,
  nodePostgresSnapshot,
} from "../../src/recipes/builtin/node-postgres/snapshot.ts";
import { bundledRecipeContentSource } from "../../src/recipes/builtin/scaffold-assets.ts";
import { recipeAssetDigest } from "../../src/recipes/builtin/snapshot-asset.ts";
import { renderAuxiliaryScaffold } from "../../src/recipes/init-pipeline/files.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...nodePostgresDefaults };
const validInput: RecipeDecomposeInput = { producer: nodePostgresProducer, options: defaults, secrets: {} };
const decomposer = nodePostgresDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: RecipeDecomposeInput["options"]) =>
  Effect.runSync(decomposer.decompose({ producer: nodePostgresProducer, options, secrets: {} }));

const authoringOf = (options: RecipeDecomposeInput["options"]) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

// The production recipe parser represents bare mapping keys as empty maps, not YAML nulls.
const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: "node-postgres/recipe.yml", content: nodePostgresRecipeYaml })),
);

describe("node-postgres decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "node-postgres",
        factory: nodePostgresDecomposer,
        producer: nodePostgresProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { node: "22" } },
        missingRecipeInput: { ...validInput, producer: { ...nodePostgresProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    const provenance = { id: "node-postgres", version: "0.1.0", producer: nodePostgresProducer, options: {} };
    expect(result.provenance).toEqual(provenance);
    expect(result.fragment).toEqual({
      runtime: 4,
      recipe: provenance,
      services: {
        web: {
          type: "node:lts",
          ports: ["3000:3000"],
          environment: { NODE_ENV: "development" },
          volumes: ["./:/app"],
          command: "node /app/server.js",
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "postgres" },
      },
    });
  });

  test("declares no recipe options or defaults", () => {
    expect(nodePostgresSnapshot.optionTypes).toEqual({});
    expect(nodePostgresSnapshot.defaults).toEqual({});
    expect(nodePostgresDefaults).toEqual({});
  });

  test("accepts the app-name prompt without recording it as a recipe option", () => {
    const result = decompose({ name: "probe" });
    expect(result.provenance.options).toEqual({});
    expect(result.fragment).toEqual(decompose({}).fragment);
  });

  test.each([
    { options: { node: "22" }, path: "options.node" },
    { options: { extra: true }, path: "options.extra" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(decomposer.decompose({ producer: nodePostgresProducer, options, secrets: {} })),
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
      { src: "assets/server.js", dest: "server.js", template: false },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([
      {
        dest: "package.json",
        digest: recipeAssetDigest(NODE_POSTGRES_PACKAGE_JSON_TEMPLATE),
        template: true,
      },
      { dest: "server.js", digest: recipeAssetDigest(NODE_POSTGRES_SERVER_JS), template: false },
    ]);
    expect(recipeAssetDigest(NODE_POSTGRES_PACKAGE_JSON_TEMPLATE)).toBe(
      "sha256:cd208e8ba15a4a27975d8769942fabf2251fe14adfe5495fc559f94b6605d916",
    );
    expect(recipeAssetDigest(NODE_POSTGRES_SERVER_JS)).toBe(
      "sha256:fe58d559317d270ef66b9a5bfbe80f09513f82c41721d5081251e6379aaba3fb",
    );
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(
      NODE_POSTGRES_CONTENT_DIGEST,
    );
    expect(NODE_POSTGRES_CONTENT_DIGEST).toBe(
      "sha256:cbaec387ad0911dd659f35ad6970123cd4c4668f10b3b7ad1d5ae768c76975a0",
    );
    expect(manifest.snapshot).toEqual(nodePostgresSnapshot);
    expect(nodePostgresSnapshot.identity.contentDigest).toBe(NODE_POSTGRES_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot when options are empty", () => {
    expect(Either.getOrThrow(renderRecipeSnapshot(nodePostgresSnapshot, {}))).toEqual(authoringOf({}));
  });

  test("preserves auxiliary scaffold bytes when the app name is probe", async () => {
    const source = bundledRecipeContentSource("node-postgres");
    const packageJson = await source({ src: "templates/package.json", dest: "package.json" });
    expect(packageJson).toBe(NODE_POSTGRES_PACKAGE_JSON_TEMPLATE);
    if (packageJson === undefined) throw new Error("Missing package scaffold");
    const rendered = renderAuxiliaryScaffold(packageJson, "probe");
    expect(rendered).toBe(NODE_POSTGRES_PACKAGE_JSON_TEMPLATE.replaceAll("{{ app.name }}", "probe"));
    expect(rendered).toBe(
      `${JSON.stringify({ name: "probe", scripts: { start: "node server.js" } }, null, 2)}\n`,
    );
    expect(await source({ src: "templates/server.js", dest: "server.js" })).toBe(NODE_POSTGRES_SERVER_JS);
  });
});
