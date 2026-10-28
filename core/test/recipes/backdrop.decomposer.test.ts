import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { fullRecipeMigratability, renderRecipeSnapshot } from "@lando/sdk/recipes";
import type { RecipeDecomposeInput } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { backdropSettings } from "../../src/recipes/builtin/backdrop/settings.ts";
import { bundledRecipe, recompiledBundledDigest } from "../_support/bundled-recipe.ts";
const {
  decomposer: backdropDecomposer,
  defaults: backdropDefaults,
  producer: backdropProducer,
  snapshot: backdropSnapshot,
  contentDigest: BACKDROP_CONTENT_DIGEST,
  manifest,
} = bundledRecipe("backdrop");
const BACKDROP_SETTINGS_VALUE = backdropSettings("{{ app.name }}");

const defaults = { ...backdropDefaults };
const alternatives = { php: "8.2", database: "mysql:8.0", composer: "2.7.7", webroot: "/app/public" };
const composerDisabled = { ...defaults, composer: false };
const validInput: RecipeDecomposeInput = { producer: backdropProducer, options: defaults, secrets: {} };
const decomposer = backdropDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, unknown>>) =>
  Effect.runSync(
    decomposer.decompose({ producer: backdropProducer, options, secrets: {} } as RecipeDecomposeInput),
  );

const authoringOf = (options: Readonly<Record<string, unknown>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

describe("backdrop decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "backdrop",
        factory: backdropDecomposer,
        producer: backdropProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...backdropProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    expect(decompose(defaults).provenance).toEqual({
      id: "backdrop",
      version: "0.1.0",
      producer: backdropProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          primary: true,
          framework: "backdrop",
          webroot: "{{ recipe.webroot }}",
          composer: "{{ recipe.composer }}",
          allowOverride: true,
          port: 80,
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
          environment: { BACKDROP_SETTINGS: BACKDROP_SETTINGS_VALUE },
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        bee: { service: "appserver", description: "Run Bee inside the appserver service.", cmds: ["bee"] },
        composer: {
          service: "appserver",
          description: "Run Composer inside the appserver service.",
          cmds: ["composer"],
        },
        php: {
          service: "appserver",
          description: "Run the PHP CLI inside the appserver service.",
          cmds: ["php"],
        },
      },
    });
  });

  test("defers the settings database name to the app scope and survives snapshot encoding", () => {
    expect(BACKDROP_SETTINGS_VALUE).toContain('"database":"{{ app.name }}"');
    const rendered = Result.getOrThrow(renderRecipeSnapshot(backdropSnapshot, defaults)) as {
      services: { appserver: { environment: { BACKDROP_SETTINGS: string } } };
    };
    expect(rendered.services.appserver.environment.BACKDROP_SETTINGS).toBe(BACKDROP_SETTINGS_VALUE);
  });

  test("drops Composer tooling when a nondefault option disables Composer", () => {
    const authoring = authoringOf(composerDisabled) as {
      services: { appserver: { composer: unknown } };
      tooling: Record<string, unknown>;
    };
    expect(authoring.services.appserver.composer).toBe("{{ recipe.composer }}");
    expect(decompose(composerDisabled).provenance.options.composer).toBe(false);
    expect(Object.keys(authoring.tooling).sort()).toEqual(["bee", "php"]);
  });

  test.each([
    { options: { ...defaults, php: 83 }, path: "options.php" },
    { options: { ...defaults, database: "postgres:16" }, path: "options.database" },
    { options: { ...defaults, composer: "false" }, path: "options.composer" },
    { options: { ...defaults, webroot: "unsafe path" }, path: "options.webroot" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.result(
        decomposer.decompose({ producer: backdropProducer, options, secrets: {} } as RecipeDecomposeInput),
      ),
    );
    expect(Result.isFailure(failure)).toBe(true);
    if (Result.isFailure(failure)) {
      expect(failure.failure.reason).toBe("option-type");
      expect(failure.failure.path).toBe(path);
      expect(failure.failure.remediation).toBeString();
    }
  });

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([]);
    expect(manifest.postInit).toHaveLength(2);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", async () => {
    expect(await recompiledBundledDigest(manifest)).toBe(BACKDROP_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(backdropSnapshot);
    expect(backdropSnapshot.identity.contentDigest).toBe(BACKDROP_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives, composerDisabled])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Result.getOrThrow(renderRecipeSnapshot(backdropSnapshot, options))).toEqual(
        authoringOf(options),
      );
    },
  );
});
