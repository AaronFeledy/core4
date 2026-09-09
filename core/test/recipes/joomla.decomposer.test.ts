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
import { joomlaDecomposer } from "../../src/recipes/builtin/joomla/decomposer.ts";
import { joomlaRecipeYaml } from "../../src/recipes/builtin/joomla/manifest.ts";
import {
  JOOMLA_CONTENT_DIGEST,
  joomlaDefaults,
  joomlaProducer,
  joomlaSnapshot,
} from "../../src/recipes/builtin/joomla/snapshot.ts";

const defaults = { ...joomlaDefaults };
const alternatives = { php: "8.1", database: "mysql:8.0", composer: "2.7.7", webroot: "/app/public" };
const composerDisabled = { ...defaults, composer: "false" };
const validInput: RecipeDecomposeInput = { producer: joomlaProducer, options: defaults, secrets: {} };
const decomposer = joomlaDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, unknown>>) =>
  Effect.runSync(
    decomposer.decompose({ producer: joomlaProducer, options, secrets: {} } as RecipeDecomposeInput),
  );

const authoringOf = (options: Readonly<Record<string, unknown>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(joomlaRecipeYaml));

describe("joomla decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "joomla",
        factory: joomlaDecomposer,
        producer: joomlaProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { ...defaults, php: 83 } },
        missingRecipeInput: { ...validInput, producer: { ...joomlaProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "joomla",
      version: "0.1.0",
      producer: joomlaProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        appserver: {
          type: "php:{{ recipe.php }}",
          framework: "joomla",
          webroot: "{{ recipe.webroot }}",
          composer: "{{ recipe.composer }}",
          allowOverride: true,
          port: 80,
          dependsOn: ["database"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "{{ recipe.database }}" },
      },
      tooling: {
        joomla: {
          service: "appserver",
          description: "Run the Joomla CLI inside the appserver service.",
          cmds: ["php cli/joomla.php"],
        },
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

  test("drops Composer tooling when a nondefault option disables Composer", () => {
    const authoring = authoringOf(composerDisabled) as {
      services: { appserver: { composer: unknown } };
      tooling: Record<string, unknown>;
    };
    expect(authoring.services.appserver.composer).toBe(false);
    expect(Object.keys(authoring.tooling)).toEqual(["joomla", "php"]);
  });

  test.each([
    { options: { ...defaults, php: 83 }, path: "options.php" },
    { options: { ...defaults, php: "5.6" }, path: "options.php" },
    { options: { ...defaults, database: "sqlite" }, path: "options.database" },
    { options: { ...defaults, composer: true }, path: "options.composer" },
    { options: { ...defaults, webroot: "app" }, path: "options.webroot" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(
        decomposer.decompose({ producer: joomlaProducer, options, secrets: {} } as RecipeDecomposeInput),
      ),
    );
    expect(Either.isLeft(failure)).toBe(true);
    if (Either.isLeft(failure)) {
      expect(failure.left.reason).toBe("option-type");
      expect(failure.left.path).toBe(path);
      expect(failure.left.remediation).toBeString();
    }
  });

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(JOOMLA_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(joomlaSnapshot);
    expect(joomlaSnapshot.identity.contentDigest).toBe(JOOMLA_CONTENT_DIGEST);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, alternatives, composerDisabled])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(joomlaSnapshot, options))).toEqual(authoringOf(options));
    },
  );
});
