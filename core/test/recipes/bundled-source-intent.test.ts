import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { renderCompiledRecipeSnapshot } from "@lando/sdk/recipes";
import { AbsolutePath, RecipeManifest, ServiceName } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { drupalDecomposer } from "../../src/recipes/builtin/drupal/decomposer.ts";
import { drupalRecipeYaml } from "../../src/recipes/builtin/drupal/manifest.ts";
import { drupalScaffoldCommand } from "../../src/recipes/builtin/drupal/scaffold-command.ts";
import { laravelDecomposer } from "../../src/recipes/builtin/laravel/decomposer.ts";
import { laravelRecipeYaml } from "../../src/recipes/builtin/laravel/manifest.ts";
import { wordpressDecomposer } from "../../src/recipes/builtin/wordpress/decomposer.ts";
import { wordpressRecipeYaml } from "../../src/recipes/builtin/wordpress/manifest.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

test.each([
  {
    id: "wordpress",
    yaml: wordpressRecipeYaml,
    decomposer: wordpressDecomposer,
    options: { php: "8.1", redis: true },
    site: "services.appserver.type",
  },
  {
    id: "laravel",
    yaml: laravelRecipeYaml,
    decomposer: laravelDecomposer,
    options: { php: "8.1", database: "postgres:16", composer: "2", webroot: "public", worker: true },
    site: "services.worker.type",
  },
  {
    id: "drupal",
    yaml: drupalRecipeYaml,
    decomposer: drupalDecomposer,
    options: {
      drupal: "10",
      php: "8.1",
      webserver: "apache",
      database: "mariadb:11.4",
      composer: "2",
      webroot: "web",
    },
    site: "tooling.drupal-scaffold.cmd",
  },
])(
  "retains authored intent after $id preview source is reloaded",
  async ({ id, yaml, decomposer, options, site }) => {
    // Given
    const manifest = await Effect.runPromise(
      parseRecipeYaml({ source: `${id}/recipe.yml`, content: yaml }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RecipeManifest)),
      ),
    );
    const encoder = plugin.configTranslators?.get("lando4");
    if (encoder === undefined) throw new Error("Missing lando4 encoder");
    const root = `/tmp/bundled-source-${id}`;
    const file = `${root}/.lando.yml`;
    if (manifest.snapshot === undefined) throw new Error("Missing bundled snapshot");
    // When
    const compiled = Result.getOrThrow(
      renderCompiledRecipeSnapshot(manifest.snapshot, options, {
        appRoot: AbsolutePath.make(root),
        env: {},
      }),
    );
    const preview = await Effect.runPromise(
      previewRecipeLandofile({
        manifest,
        decomposer,
        answers: options,
        appName: "source-intent",
        encoder: await encoder(),
      }),
    );
    const loaded = await Effect.runPromise(
      parseLandofile({ file, cwd: root, content: preview.text }).pipe(
        Effect.flatMap((value) => loadAuthoredDocuments([{ file, value }], { appRoot: root, file })),
      ),
    );
    // Then
    expect(compiled.pendingSites.map((pending) => pending.path.join("."))).toContain(site);
    expect(loaded.document.services?.[ServiceName.make("appserver")]?.type).toBe("php:8.1");
    if (id === "drupal")
      expect(loaded.document.tooling?.["drupal-scaffold"]?.cmd).toBe(drupalScaffoldCommand("10"));
    expect(
      loaded.pendingSites.some(
        (pending) => pending.path.join(".") === "services.appserver.routes.0.hostname",
      ),
    ).toBe(true);
  },
);
