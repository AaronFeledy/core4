import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { AbsolutePath, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { source } from "../../src/recipes/builtin/symfony/source.ts";
import { makeCompiledRecipeDecomposer } from "../../src/recipes/compiled-decomposer.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";

test("scaffolds snapshot-authored URL sites without promoting option-produced binding text", async () => {
  // Given
  const manifest = Result.getOrThrow(
    compileRecipeSource(
      {
        ...source,
        options: { ...source.options, webroot: { type: { kind: "string" }, default: "public" } },
      },
      { sourceKind: "local", packageName: "fixture", assets: [] },
    ),
  );
  const decomposer = makeCompiledRecipeDecomposer(manifest, {
    source: "fixture",
    appRoot: AbsolutePath.make("/tmp/compiled-init"),
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
