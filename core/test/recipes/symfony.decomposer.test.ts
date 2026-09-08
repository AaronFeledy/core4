import { describe, expect, test } from "bun:test";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { symfonyDecomposer } from "../../src/recipes/builtin/symfony/decomposer.ts";
import { symfonyRecipeYaml } from "../../src/recipes/builtin/symfony/manifest.ts";
import { symfonyProducer, symfonySnapshot } from "../../src/recipes/builtin/symfony/snapshot.ts";

const defaults = { php: "8.3", database: "postgres:16", composer: "2", webroot: "/app/public" };
const alternate = { php: "8.4", database: "mariadb:11.4", composer: "2.7.7", webroot: "/app/web" };
const composerFalse = { ...defaults, composer: "false" };
const validInput: RecipeDecomposeInput = { producer: symfonyProducer, options: defaults, secrets: {} };
const decomposer = symfonyDecomposer({
  redactor: { redactString: (text) => text, redactValue: (value) => value },
});
const expected = {
  runtime: 4,
  services: {
    appserver: {
      type: "php:{{ recipe.php }}",
      framework: "symfony",
      webroot: "{{ recipe.webroot }}",
      composer: "{{ recipe.composer }}",
      allowOverride: true,
      port: 80,
      dependsOn: ["database", "cache"],
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    },
    database: { type: "{{ recipe.database }}" },
    cache: { type: "redis" },
  },
  tooling: {
    console: {
      service: "appserver",
      description: "Run the Symfony console inside the appserver service.",
      cmds: ["php bin/console"],
    },
    composer: {
      service: "appserver",
      description: "Run Composer inside the appserver service.",
      cmds: ["composer"],
    },
  },
} as const;

describe("symfony decomposition", () => {
  test("satisfies the provider-free decomposer contract when inputs are valid or invalid", async () => {
    // Given only the redactor port supplied by the contract harness.
    const harness = {
      name: "symfony",
      factory: symfonyDecomposer,
      producer: symfonyProducer,
      validInput,
      typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
      missingRecipeInput: { ...validInput, producer: { ...symfonyProducer, recipeId: "missing" } },
    };
    // When the provider-free contract runs, then all assertions succeed.
    await Effect.runPromise(runRecipeDecomposerContractSuite(harness));
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    // Given merged default options.
    // When decomposition runs without an Effect context.
    const result = Effect.runSync(decomposer.decompose(validInput));
    // Then provenance is retained and Composer tooling is present.
    const provenance = { id: "symfony", version: "0.1.0", producer: symfonyProducer, options: defaults };
    expect<unknown>(result).toEqual({ fragment: { ...expected, recipe: provenance }, provenance });
    if (typeof result.fragment === "string") throw new TypeError("Expected an object fragment.");
    const services = result.fragment.services;
    if (services === undefined || typeof services === "string")
      throw new TypeError("Expected an object service map.");
    const appserver = services.appserver;
    if (appserver === undefined || typeof appserver === "string")
      throw new TypeError("Expected an object appserver service.");
    expect(Object.keys(appserver)).toEqual(Object.keys(expected.services.appserver));
  });

  test("returns the exact authoring fragment when non-default options are supplied", () => {
    // Given non-default persistable options.
    const options = alternate;
    // When decomposition runs.
    const result = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    // Then option values stay in provenance, not interpolated service fields.
    const provenance = { id: "symfony", version: "0.1.0", producer: symfonyProducer, options };
    expect<unknown>(result).toEqual({ fragment: { ...expected, recipe: provenance }, provenance });
  });

  test("disables Composer and omits its tooling when composer is false", () => {
    // Given the renderer-supported false string.
    const options = composerFalse;
    // When decomposed.
    const { fragment, provenance } = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    // Then appserver.composer is boolean false and tooling.composer is absent.
    expect<unknown>(fragment).toEqual({
      ...expected,
      recipe: provenance,
      services: { ...expected.services, appserver: { ...expected.services.appserver, composer: false } },
      tooling: { console: expected.tooling.console },
    });
  });

  test("publishes exactly the declared file and post-init inventory", () => {
    // Given the published recipe YAML.
    const raw = Bun.YAML.parse(symfonyRecipeYaml);
    // When decoded through the public manifest contract.
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(raw);
    // Then only the Landofile and the existing message are declared.
    expect<unknown>(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect<unknown>(manifest.postInit).toEqual([
      { type: "message", text: "Run 'lando start' inside the new app directory to bring Symfony up." },
    ]);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot", () => {
    // Given the schema-decoded published snapshot.
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(symfonyRecipeYaml));
    // When its canonical content identity is recomputed.
    const digest = computeRecipeContentDigest(recipeContentDigestProjection(manifest));
    // Then identity and migratability agree with the manifest.
    expect<unknown>(digest).toBe(manifest.snapshot?.identity.contentDigest);
    expect(manifest.snapshot?.identity.recipeId).toBe(manifest.id);
    expect(manifest.snapshot?.identity.manifestVersion).toBe(manifest.version);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(manifest.snapshot).toEqual(symfonySnapshot);
  });

  test.each([defaults, alternate, composerFalse])(
    "agrees with the snapshot when options are %j",
    (options) => {
      // Given the decomposed authoring data without provenance or app name.
      const result = Effect.runSync(decomposer.decompose({ ...validInput, options }));
      if (typeof result.fragment === "string") throw new TypeError("Expected an object fragment.");
      const { recipe: _recipe, ...fragment } = result.fragment;
      // When the declarative snapshot renders once.
      const rendered = Either.getOrThrow(renderRecipeSnapshot(symfonySnapshot, options));
      // Then expression-shaped strings remain inert authoring data.
      expect<unknown>(rendered).toEqual(fragment);
    },
  );
});
