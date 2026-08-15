import { describe, expect, test } from "bun:test";

import { manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => String(typeof entry === "string" ? entry : entry.id));

describe("@lando/provider-docker plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
  });

  test("runtimeProviders keys match manifest.contributes.providers", () => {
    // Given
    const manifestProviderIds = contributionIds(manifest.contributes?.providers);

    // When
    const runtimeProviderIds = [...(plugin.runtimeProviders?.keys() ?? [])].map(String);

    // Then
    expect(runtimeProviderIds).toEqual([...manifestProviderIds]);
  });
});
