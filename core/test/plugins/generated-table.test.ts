import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import { BUNDLED_RENDERER_MODULES } from "../../src/plugins/generated/renderers.ts";

const EXPECTED_PLUGIN_NAMES = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/provider-podman",
  "@lando/service-lando",
  "@lando/renderer-lando",
  "@lando/notify-lando",
  "@lando/file-sync-mutagen",
  "@lando/ca-mkcert",
  "@lando/proxy-traefik",
  "@lando/ssh-agent",
  "@lando/template-handlebars",
  "@lando/template-mustache",
  "@lando/sql",
];

const generatedDir = resolve(import.meta.dirname, "../../src/plugins/generated");

describe("generated bundled plugin descriptor tables", () => {
  test("preserves the bundled ship-list order with matching descriptor names", () => {
    // Given: the generated full bundled descriptor table.
    // When: its descriptor and manifest names are projected in order.
    const names = BUNDLED_PLUGIN_MODULES.map((module) => module.name);
    const manifestNames = BUNDLED_PLUGIN_MODULES.map((module) => String(module.manifest.name));

    // Then: both projections match the stable ship list.
    expect(names).toEqual(EXPECTED_PLUGIN_NAMES);
    expect(manifestNames).toEqual(EXPECTED_PLUGIN_NAMES);
  });

  test("keeps only renderer-contributing descriptors on the cold-start path", () => {
    // Given: the generated cold-start renderer descriptor table.
    // When: its plugin names are inspected.
    const names = BUNDLED_RENDERER_MODULES.map((module) => module.name);

    // Then: only the renderer-contributing plugin is imported.
    expect(names).toEqual(["@lando/renderer-lando"]);
  });

  test("marks both descriptor tables as generated", async () => {
    // Given: both generated descriptor table sources.
    // When: their source text is read.
    const sources = await Promise.all([
      readFile(resolve(generatedDir, "bundled.ts"), "utf8"),
      readFile(resolve(generatedDir, "renderers.ts"), "utf8"),
    ]);

    // Then: each carries the standard generator ownership header.
    for (const source of sources) {
      expect(source.startsWith("/**\n * **GENERATED FILE** — do not edit by hand.")).toBe(true);
      expect(source).toContain("scripts/build-bundled-plugins.ts");
    }
  });
});
