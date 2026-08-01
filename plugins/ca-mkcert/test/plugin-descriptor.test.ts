import { describe, expect, test } from "bun:test";

import { CA_ID, PLUGIN_NAME, engine, manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/ca-mkcert plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("manifest and descriptor expose the same certificate authority", () => {
    const caIds = contributionIds(manifest.contributes?.certificateAuthorities);

    expect(caIds).toContain(CA_ID);
    expect(plugin.certificateAuthorities?.get(CA_ID)).toBe(engine);
    expect(plugin.layer).toBeUndefined();
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.certificateAuthorities?.get(CA_ID)).toBe(engine);
  });
});
