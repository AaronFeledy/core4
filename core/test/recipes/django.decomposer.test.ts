import { describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest, type RecipeOptionValue } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Either, Schema } from "effect";
import { djangoDecomposer } from "../../src/recipes/builtin/django/decomposer.ts";
import { djangoRecipeSource, djangoRecipeYaml } from "../../src/recipes/builtin/django/manifest.ts";
import {
  DJANGO_CONTENT_DIGEST,
  djangoDefaults,
  djangoProducer,
  djangoSnapshot,
} from "../../src/recipes/builtin/django/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...djangoDefaults };
const withWorker = { celery: true };
const validInput: RecipeDecomposeInput = { producer: djangoProducer, options: defaults, secrets: {} };
const decomposer = djangoDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: djangoProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: djangoRecipeSource, content: djangoRecipeYaml })),
);

describe("django decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "django",
        factory: djangoDecomposer,
        producer: djangoProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { celery: "yes" } },
        missingRecipeInput: { ...validInput, producer: { ...djangoProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment when default options are supplied", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "django",
      version: "0.1.0",
      producer: djangoProducer,
      options: defaults,
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        web: {
          type: "python:3.12",
          framework: "django",
          port: 8000,
          dependsOn: ["database", "cache"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "postgres" },
        cache: { type: "redis" },
      },
      tooling: {
        django: {
          service: "web",
          description: "Run the Django management script inside the web service.",
          cmds: ["python manage.py"],
        },
        pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
      },
    });
    expect<unknown>(result.fragment).toEqual({
      runtime: 4,
      recipe: result.provenance,
      ...authoringOf(defaults),
    });
  });

  test("adds the Celery worker service at decomposition time when the option is enabled", () => {
    const authoring = Schema.decodeUnknownSync(
      Schema.Struct({ services: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }),
    )(authoringOf(withWorker));
    expect(Object.keys(authoring.services)).toEqual(["web", "database", "cache", "worker"]);
    expect<unknown>(authoring.services.worker).toEqual({
      type: "python:3.12",
      framework: "django",
      command: "celery -A app worker --loglevel=info",
      dependsOn: ["database", "cache"],
    });
  });

  test("tolerates the app-name answer the translator forwards alongside declared options", () => {
    const result = decompose({ ...defaults, name: "probe" });
    expect(result.provenance.options).toEqual({ ...defaults, name: "probe" });
    expect(authoringOf({ ...defaults, name: "probe" })).toEqual(authoringOf(defaults));
  });

  test.each([
    { options: { celery: "true" }, path: "options.celery" },
    { options: { celery: 1 }, path: "options.celery" },
    { options: {}, path: "options.celery" },
  ])("rejects a typed option failure when input is %j", ({ options, path }) => {
    const failure = Effect.runSync(
      Effect.either(decomposer.decompose({ producer: djangoProducer, options, secrets: {} })),
    );
    expect(Either.isLeft(failure)).toBe(true);
    if (Either.isLeft(failure)) {
      expect(failure.left.reason).toBe("option-type");
      expect(failure.left.path).toBe(path);
      expect(failure.left.remediation).toBe("Supply true or false.");
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
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(DJANGO_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(djangoSnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test.each([defaults, withWorker])(
    "renders the same authoring data from the snapshot when options are %j",
    (options) => {
      expect(Either.getOrThrow(renderRecipeSnapshot(djangoSnapshot, options))).toEqual(authoringOf(options));
    },
  );
});
