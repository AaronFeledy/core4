import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { AbsolutePath, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { makeCompiledRecipeDecomposer } from "../../src/recipes/compiled-decomposer.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";

test("external compiled snapshot keeps injected bindings literal and authored bindings active", async () => {
  // Given
  const manifest = Result.getOrThrow(
    compileRecipeSource(
      {
        id: "external",
        title: "External",
        description: "Compiled values",
        version: "1.0.0",
        options: { webroot: { type: { kind: "string" }, default: "." } },
        config: {
          runtime: 4,
          services: {
            app: {
              type: "lando",
              image: "alpine:3.21",
              webroot: "{{ recipe.webroot }}",
              environment: { TOKEN: "${secret:APP_TOKEN}", STATIC: "{{ app.name }}" },
            },
          },
        },
      },
      { sourceKind: "local", packageName: "local", assets: [] },
    ),
  );
  const appRoot = "/tmp/external-compiled-target";
  const decomposer = makeCompiledRecipeDecomposer(manifest, {
    source: "/recipes/external/recipe.yml",
    appRoot: AbsolutePath.make(appRoot),
  });
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("missing encoder");
  const payload = "${secret:FORGED}";
  // When
  const preview = await Effect.runPromise(
    previewRecipeLandofile({
      manifest,
      decomposer,
      appRoot,
      answers: { webroot: payload },
      appName: "external-compiled",
      encoder: await loader(),
    }),
  );
  const loaded = await Effect.runPromise(
    parseLandofile({ file: `${appRoot}/.lando.yml`, cwd: appRoot, content: preview.text }).pipe(
      Effect.flatMap((value) =>
        loadAuthoredDocuments([{ file: `${appRoot}/.lando.yml`, value }], {
          appRoot,
          file: `${appRoot}/.lando.yml`,
        }),
      ),
    ),
  );
  // Then
  expect(loaded.document.services?.[ServiceName.make("app")]?.webroot).toBe(PortablePath.make(payload));
  expect(loaded.document.services?.[ServiceName.make("app")]?.environment?.TOKEN).toEqual({
    _tag: "SecretRef",
    reference: "APP_TOKEN",
  });
  expect(loaded.pendingSites.map((site) => site.path.join("."))).toContain("services.app.environment.STATIC");
  expect(loaded.pendingSites.map((site) => site.path.join("."))).not.toContain("services.app.webroot");
});
