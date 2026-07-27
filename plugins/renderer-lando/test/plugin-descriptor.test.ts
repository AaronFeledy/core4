import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { manifest, plugin } from "../src/index.ts";

describe("renderer plugin descriptor", () => {
  test("matches the renderer declarations in the manifest", () => {
    // Given
    const expectedRendererIds = (manifest.contributes?.renderers ?? []).map((contribution) =>
      typeof contribution === "string" ? contribution : contribution.id,
    );

    // When
    const rendererIds = [...(plugin.renderers?.keys() ?? [])];

    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(rendererIds).toEqual(expectedRendererIds);
  });

  test("contributes the complete lando renderer contract", () => {
    // Given
    const rendererId = "lando";

    // When
    const contribution = plugin.renderers?.get(rendererId);

    // Then
    expect(contribution?.id).toBe(rendererId);
    expect(typeof contribution?.makeService).toBe("function");
    expect(typeof contribution?.makeEventConsumer).toBe("function");
    expect(typeof contribution?.loadInteractivePromptDriver).toBe("function");
  });

  test("keeps OpenTUI out of the plugin entry's eager import graph", () => {
    // Given
    const indexSource = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

    // When
    const imports = new Bun.Transpiler({ loader: "ts" }).scan(indexSource).imports;
    const opentuiImports = imports.filter((edge) => edge.path.startsWith("@opentui/"));
    const promptDriverImports = imports
      .filter((edge) => edge.path.startsWith("./opentui/prompt-driver"))
      .map(({ kind, path }) => ({ kind, path }));

    // Then
    expect(opentuiImports).toEqual([]);
    expect(promptDriverImports).toEqual([{ kind: "dynamic-import", path: "./opentui/prompt-driver.ts" }]);
  });
});
