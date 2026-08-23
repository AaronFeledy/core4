import { describe, expect, test } from "bun:test";

import { PLUGIN_NAME, manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

describe("@lando/sql plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("every manifest.contributes.commands id has a matching commands Map entry", () => {
    // Given
    const commandIds = contributionIds(manifest.contributes?.commands);

    // When / Then
    expect(commandIds.length).toBeGreaterThan(0);
    for (const id of commandIds) {
      expect(plugin.commands?.has(id)).toBe(true);
    }
  });

  test("each command loader returns a db-namespace app-bootstrap spec with a resultSchema", async () => {
    // Given
    const commandIds = contributionIds(manifest.contributes?.commands);

    // When / Then
    for (const id of commandIds) {
      const loader = plugin.commands?.get(id);
      expect(typeof loader).toBe("function");
      if (typeof loader !== "function") throw new Error(`expected command loader for ${id}`);
      const spec = await loader();
      expect(spec.id).toBe(id);
      expect(spec.namespace).toBe("db");
      expect(spec.bootstrap).toBe("app");
      expect(spec.resultSchema).toBeDefined();
    }
  });

  test("descriptor values are reference-identical to existing exports", () => {
    expect(plugin.manifest).toBe(manifest);
  });
});
