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
import { wordpressDecomposer } from "../../src/recipes/builtin/wordpress/decomposer.ts";
import { wordpressRecipeYaml } from "../../src/recipes/builtin/wordpress/manifest.ts";
import {
  WORDPRESS_CONTENT_DIGEST,
  wordpressProducer,
  wordpressSnapshot,
} from "../../src/recipes/builtin/wordpress/snapshot.ts";

const validInput: RecipeDecomposeInput = {
  producer: wordpressProducer,
  options: { php: "8.3", redis: false },
  secrets: {},
};
const typedOptionFailureInput: RecipeDecomposeInput = { ...validInput, options: { php: 83, redis: false } };
const missingRecipeInput: RecipeDecomposeInput = {
  ...validInput,
  producer: { ...wordpressProducer, recipeId: "missing" },
};
const decomposer = wordpressDecomposer({ redactor: createStandaloneRedactor("secrets") });
const cases = [
  { php: "8.3", redis: false },
  { php: "8.2", redis: true },
] as const;

describe("wordpress decomposition", () => {
  test("satisfies the provider-free shared contract when given valid and invalid inputs", async () => {
    // Given / When: only the redactor port is supplied by the contract harness.
    const result = await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "wordpress",
        factory: wordpressDecomposer,
        producer: wordpressProducer,
        validInput,
        typedOptionFailureInput,
        missingRecipeInput,
      }),
    );
    // Then
    expect(result).toBeUndefined();
  });

  test.each([...cases])("returns exact authoring data when options are %j", (options) => {
    // Given / When
    const result = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    // Then
    const provenance = { id: "wordpress", version: "0.1.0", producer: wordpressProducer, options };
    expect<unknown>(result).toEqual({
      provenance,
      fragment: {
        runtime: 4,
        recipe: provenance,
        services: {
          appserver: {
            type: "php:{{ recipe.php }}",
            framework: "wordpress",
            port: 80,
            dependsOn: options.redis ? ["database", "cache"] : ["database"],
            routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          },
          database: { type: "mariadb" },
          ...(options.redis ? { cache: { type: "redis" } } : {}),
        },
        tooling: {
          wp: { service: "appserver", description: "Run WP-CLI inside the appserver service.", cmds: ["wp"] },
          composer: {
            service: "appserver",
            description: "Run Composer inside the appserver service.",
            cmds: ["composer"],
          },
        },
      },
    });
  });

  test.each([
    { options: { php: 83, redis: false }, path: "options.php" },
    { options: { php: "8.4", redis: false }, path: "options.php" },
    { options: { php: "8.3", redis: "true" }, path: "options.redis" },
  ])("rejects a bad option when input is %j", ({ options, path }) => {
    // Given / When
    const error = Effect.runSync(Effect.flip(decomposer.decompose({ ...validInput, options })));
    // Then
    expect(error).toMatchObject({ _tag: "RecipeDecomposeError", reason: "option-type", path });
  });

  test("publishes the exact inventory when the manifest is decoded", () => {
    // Given / When
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(wordpressRecipeYaml));
    // Then
    expect<unknown>(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect<unknown>(manifest.postInit).toEqual([
      { type: "message", text: "Run 'lando start' inside the new app directory to bring WordPress up." },
    ]);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot when the manifest is decoded", () => {
    // Given / When
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(wordpressRecipeYaml));
    // Then
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(
      WORDPRESS_CONTENT_DIGEST,
    );
    expect(manifest.snapshot).toEqual(wordpressSnapshot);
    expect(wordpressSnapshot.identity.contentDigest).toBe(WORDPRESS_CONTENT_DIGEST);
    expect(wordpressSnapshot.identity.recipeId).toBe(manifest.id);
    expect(wordpressSnapshot.identity.manifestVersion).toBe(manifest.version);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(wordpressSnapshot.optionTypes).toEqual({
      php: { kind: "enum", values: ["8.2", "8.3"] },
      redis: { kind: "boolean" },
    });
    expect(wordpressSnapshot.defaults).toEqual({ php: "8.3", redis: false });
  });

  test.each([...cases])("renders the same snapshot when options are %j", (options) => {
    // Given
    const { fragment } = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    const {
      recipe: _recipe,
      name: _name,
      ...authoring
    } = Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(fragment);
    // When
    const rendered = Either.getOrThrow(renderRecipeSnapshot(wordpressSnapshot, options));
    // Then
    expect<unknown>(rendered).toEqual(authoring);
  });
});
