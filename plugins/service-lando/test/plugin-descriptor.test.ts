import { describe, expect, test } from "bun:test";

import {
  PLUGIN_NAME,
  appFeatures,
  globalServices,
  manifest,
  plugin,
  serviceFeatures,
  serviceTypes,
  services,
} from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/service-lando plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.contributes id has a matching descriptor entry", () => {
    // Given
    const contributes = manifest.contributes ?? {};

    // When / Then — serviceTypes
    for (const id of contributionIds(contributes.serviceTypes)) {
      expect(plugin.serviceTypes?.has(id)).toBe(true);
    }

    // When / Then — serviceFeatures
    for (const id of contributionIds(contributes.serviceFeatures)) {
      expect(plugin.serviceFeatures?.has(id)).toBe(true);
    }

    // When / Then — appFeatures
    for (const id of contributionIds(contributes.appFeatures)) {
      expect(plugin.appFeatures?.has(id)).toBe(true);
    }

    // When / Then — globalServices
    for (const id of contributionIds(contributes.globalServices)) {
      expect(plugin.globalServices?.has(id)).toBe(true);
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.layer).toBe(services);
    expect(plugin.serviceTypes).toBe(serviceTypes);
    expect(plugin.serviceFeatures).toBe(serviceFeatures);
    expect(plugin.appFeatures).toBe(appFeatures);
    expect(plugin.globalServices).toBe(globalServices);
  });
});
