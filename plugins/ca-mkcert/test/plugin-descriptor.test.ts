import { describe, expect, test } from "bun:test";

import { CA_ID, PLUGIN_NAME, engine, manifest, plugin } from "../src/index.ts";

describe("@lando/ca-mkcert plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.name).toBe(PLUGIN_NAME);
  });

  test("manifest and descriptor expose the same certificate authority", () => {
    const caIds = (manifest.contributes?.certificateAuthorities ?? []).map((entry) => entry.id);

    expect(caIds).toContain(CA_ID);
    expect(plugin.certificateAuthorities?.get(CA_ID)).toBe(engine);
    expect(plugin.layer).toBeUndefined();
  });

  test("descriptor values are reference-identical to existing exports", () => {
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.certificateAuthorities?.get(CA_ID)).toBe(engine);
  });
});
