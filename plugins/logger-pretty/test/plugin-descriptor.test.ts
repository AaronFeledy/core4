import { describe, expect, test } from "bun:test";

import { PLUGIN_NAME, logger, manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/logger-pretty plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.contributes.loggers id has a matching descriptor entry", () => {
    // Given
    const loggerIds = contributionIds(manifest.contributes?.loggers);

    // When / Then
    for (const id of loggerIds) {
      expect(plugin.loggers?.has(id)).toBe(true);
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.layer).toBe(logger);
    for (const id of contributionIds(manifest.contributes?.loggers)) {
      expect(plugin.loggers?.get(id)).toBe(logger);
    }
  });
});
