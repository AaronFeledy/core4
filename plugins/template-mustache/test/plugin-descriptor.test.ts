import { describe, expect, test } from "bun:test";

import { PLUGIN_NAME, manifest, plugin, templateEngine, templateEngines } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/template-mustache plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.contributes.templateEngines id has a matching descriptor entry", () => {
    // Given
    const engineIds = contributionIds(manifest.contributes?.templateEngines);

    // When / Then
    for (const id of engineIds) {
      expect(plugin.templateEngines?.has(id)).toBe(true);
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.layer).toBe(templateEngine);
    expect(plugin.templateEngines).toBe(templateEngines);
  });
});
