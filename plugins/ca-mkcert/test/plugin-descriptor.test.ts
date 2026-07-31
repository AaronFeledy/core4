import { describe, expect, test } from "bun:test";

import packageJson from "../package.json";
import { CA_ID, PLUGIN_NAME, certificateAuthorities, engine, manifest, plugin } from "../src/index.ts";

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

  test("manifest.contributes.cas is declared and descriptor exposes the CA layer", () => {
    // Given
    const caIds = contributionIds(manifest.contributes?.cas);

    // When / Then
    expect(caIds).toContain(CA_ID);
    expect(plugin.certificateAuthorities?.get(CA_ID)).toBe(engine);
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.layer).toBe(engine);
    expect(plugin.certificateAuthorities).toBe(certificateAuthorities);
  });

  test("published package includes the pinned mkcert manifest", () => {
    expect(packageJson.files).toContain("./mkcert-versions.json");
  });
});
