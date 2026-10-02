import { expect, test } from "bun:test";
import { PluginManifest } from "@lando/sdk/schema";
import { Schema } from "effect";

test("manifest and descriptor expose the op secret store without an eager layer", async () => {
  // Given
  const { plugin, manifest, onePasswordSecretStore } = await import("../src/index.ts");
  // When
  const store = plugin.secretStores?.get("1password");
  // Then
  expect(plugin.name).toBe("@lando/secret-store-1password");
  expect(plugin.manifest).toBe(manifest);
  expect(manifest.contributes?.secretStores).toEqual([
    { id: "1password", module: "./src/store.ts", schemes: ["op"] },
  ]);
  expect(store).toBe(onePasswordSecretStore);
  expect(plugin.layer).toBeUndefined();
});

test("on-disk manifest agrees with the bundled descriptor", async () => {
  // Given
  const { manifest } = await import("../src/index.ts");
  const yaml = await Bun.file(new URL("../plugin.yaml", import.meta.url)).text();
  // When
  const decoded = Schema.decodeUnknownSync(PluginManifest)(Bun.YAML.parse(yaml));
  // Then
  expect(decoded).toEqual(manifest);
});
