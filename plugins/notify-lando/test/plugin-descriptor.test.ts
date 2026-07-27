import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_NAME, manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/notify-lando plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.subscribers id has a matching subscriberFactoryLoaders entry", () => {
    // Given
    const subscriberIds = contributionIds(manifest.subscribers);

    // When / Then
    for (const id of subscriberIds) {
      expect(plugin.subscriberFactoryLoaders?.has(id)).toBe(true);
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    // Given / When the descriptor wraps existing package exports
    // Then
    expect(plugin.manifest).toBe(manifest);
  });

  test("subscriber factory loader is a function and is not eagerly imported at module load", () => {
    // Given
    const loader = plugin.subscriberFactoryLoaders?.get("notify-command-terminal");
    const indexSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
      "utf8",
    );

    // When / Then — loader is deferred (function), not a pre-resolved module
    expect(typeof loader).toBe("function");
    if (typeof loader !== "function") throw new Error("expected subscriber factory loader");
    expect(loader()).toBeInstanceOf(Promise);
    // Static import of notify would eagerly load the factory at module evaluate time
    expect(indexSource).not.toMatch(/from\s+["']\.\/notify(?:\.ts)?["']/);
    expect(indexSource).not.toMatch(/import\s+["']\.\/notify(?:\.ts)?["']/);
  });
});
