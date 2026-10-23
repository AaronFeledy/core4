import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { PortablePath, RecipeManifest, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { makeOptionBearingDecomposer } from "../../src/recipes/builtin/option-bearing-decomposer.ts";
import { symfonyRecipeSource, symfonyRecipeYaml } from "../../src/recipes/builtin/symfony/manifest.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

test("scaffolds snapshot-authored URL sites without promoting option-produced binding text", async () => {
  // Given
  const original = Effect.runSync(
    parseRecipeYaml({ source: symfonyRecipeSource, content: symfonyRecipeYaml }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RecipeManifest)),
    ),
  );
  if (original.snapshot === undefined) throw new Error("fixture snapshot missing");
  const snapshot = {
    ...original.snapshot,
    optionTypes: { ...original.snapshot.optionTypes, webroot: { kind: "string" as const } },
  };
  const manifest = { ...original, snapshot };
  const decomposer = makeOptionBearingDecomposer({
    producer: snapshot.identity,
    displayName: "compiled fixture",
    optionTypes: snapshot.optionTypes,
    fragment: () => ({ services: {} }),
  });
  const encoderLoader = plugin.configTranslators?.get("lando4");
  if (encoderLoader === undefined) throw new Error("lando4 encoder missing");
  const payload = "${secret:FORGED}";
  // When
  const preview = await Effect.runPromise(
    previewRecipeLandofile({
      manifest,
      decomposer,
      answers: { php: "8.4", composer: "2", webroot: payload, database: "postgres:16" },
      appName: "compiled-init",
      encoder: await encoderLoader(),
    }),
  );
  const loaded = await Effect.runPromise(
    parseLandofile({
      file: "/tmp/compiled-init/.lando.yml",
      cwd: "/tmp/compiled-init",
      content: preview.text,
    }).pipe(
      Effect.flatMap((value) =>
        loadAuthoredDocuments([{ file: "/tmp/compiled-init/.lando.yml", value }], {
          appRoot: "/tmp/compiled-init",
          file: "/tmp/compiled-init/.lando.yml",
        }),
      ),
    ),
  );
  // Then
  expect(loaded.document.services?.[ServiceName.make("appserver")]?.webroot).toBe(PortablePath.make(payload));
  expect(
    loaded.pendingSites.some((site) => site.path.join(".") === "services.appserver.environment.DATABASE_URL"),
  ).toBe(true);
  expect(loaded.pendingSites.some((site) => site.path.join(".") === "services.appserver.webroot")).toBe(
    false,
  );
});
