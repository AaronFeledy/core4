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
import { lempDecomposer } from "../../src/recipes/builtin/lemp/decomposer.ts";
import { lempRecipeYaml } from "../../src/recipes/builtin/lemp/manifest.ts";
import { lempProducer, lempSnapshot } from "../../src/recipes/builtin/lemp/snapshot.ts";

const validInput: RecipeDecomposeInput = {
  producer: lempProducer,
  options: { php: "8.3" },
  secrets: {},
};
const typedOptionFailureInput: RecipeDecomposeInput = { ...validInput, options: { php: 83 } };
const missingRecipeInput: RecipeDecomposeInput = {
  ...validInput,
  producer: { ...lempProducer, recipeId: "missing" },
};
const decomposer = lempDecomposer({
  redactor: { redactString: (text) => text, redactValue: (value) => value },
});
const authoring = {
  runtime: 4,
  services: {
    web: {
      type: "nginx",
      port: 80,
      dependsOn: ["appserver"],
      routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
    },
    appserver: { type: "php:{{ recipe.php }}", framework: "none", dependsOn: ["database"] },
    database: { type: "mariadb" },
  },
  tooling: {
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
} as const;

describe("lemp decomposition", () => {
  test("satisfies the shared contract without provider, planner, or filesystem ports", async () => {
    // Given only the redactor port supplied by the contract harness.
    const harness = {
      name: "lemp",
      factory: lempDecomposer,
      producer: lempProducer,
      validInput,
      typedOptionFailureInput,
      missingRecipeInput,
    };
    // When the provider-free contract runs, then all assertions succeed.
    await Effect.runPromise(runRecipeDecomposerContractSuite(harness));
  });

  test.each(["8.3", "8.2"])("preserves the exact authoring fragment when php is %s", (php) => {
    // Given merged default or non-default options.
    const options = { php };
    // When decomposition runs without an Effect context.
    const result = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    // Then the options are provenance, not eagerly interpolated service values.
    const provenance = { id: "lemp", version: "0.1.0", producer: lempProducer, options };
    expect<unknown>(result).toEqual({ fragment: { ...authoring, recipe: provenance }, provenance });
    if (typeof result.fragment === "string") throw new TypeError("Expected an object fragment");
    expect(Object.keys(result.fragment.services ?? {})).toEqual(["web", "appserver", "database"]);
  });

  test.each([{ php: "8.4" }, { php: 83 }, { php: false }, { php: ["8.3"] }])(
    "rejects invalid php option %j",
    ({ php }) => {
      // Given a value outside the persistable PHP enum.
      const input = { ...validInput, options: { php } };
      // When decomposition fails.
      const error = Effect.runSync(Effect.flip(decomposer.decompose(input)));
      // Then it identifies the option boundary.
      expect(error).toMatchObject({
        _tag: "RecipeDecomposeError",
        reason: "option-type",
        path: "options.php",
      });
    },
  );

  test("publishes exactly the declared file and post-init inventory", () => {
    // Given the published recipe YAML.
    const raw = Bun.YAML.parse(lempRecipeYaml);
    // When decoded through the public manifest contract.
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(raw);
    // Then only the Landofile and the existing message are declared.
    expect<unknown>(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect<unknown>(manifest.postInit).toEqual([
      { type: "message", text: "Run 'lando start' inside the new app directory to bring the LEMP stack up." },
    ]);
    expect(manifest.snapshot?.assets).toEqual([]);
    expect(manifest.snapshot?.optionTypes).toEqual({ php: { kind: "enum", values: ["8.2", "8.3"] } });
    expect(manifest.snapshot?.defaults).toEqual({ php: "8.3" });
  });

  test("publishes a self-consistent migratable snapshot", () => {
    // Given the schema-decoded published snapshot.
    const manifest = Schema.decodeUnknownSync(RecipeManifest)(Bun.YAML.parse(lempRecipeYaml));
    // When its canonical content identity is recomputed.
    const digest = computeRecipeContentDigest(recipeContentDigestProjection(manifest));
    // Then identity and migratability agree with the manifest.
    expect<unknown>(digest).toBe(manifest.snapshot?.identity.contentDigest);
    expect(manifest.snapshot?.identity.recipeId).toBe(manifest.id);
    expect(manifest.snapshot?.identity.manifestVersion).toBe(manifest.version);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
    expect(manifest.snapshot).toEqual(lempSnapshot);
  });

  test.each(["8.3", "8.2"])("matches snapshot rendering when php is %s", (php) => {
    // Given the decomposed authoring data without provenance or app name.
    const options = { php };
    const result = Effect.runSync(decomposer.decompose({ ...validInput, options }));
    if (typeof result.fragment === "string") throw new TypeError("Expected an object fragment");
    const { recipe: _recipe, name: _name, ...fragment } = result.fragment;
    // When the declarative snapshot renders once.
    const rendered = Either.getOrThrow(renderRecipeSnapshot(lempSnapshot, options));
    // Then expression-shaped strings remain inert authoring data.
    expect<unknown>(rendered).toEqual(fragment);
  });
});
