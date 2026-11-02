import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathsService, PluginTrustStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { layer as trustLayer } from "../../src/plugins/trust-store";
import { layerWith } from "../../src/services/config";

test("plugin trust persists beneath the runtime's user config root", async () => {
  // Given a host-selected config root and policy-disabled ambient inputs.
  const root = await mkdtemp(join(tmpdir(), "lando-trust-root-"));
  const configLayer = layerWith({
    env: {},
    sources: { user: false, env: false },
    rootOverrides: { userConfRoot: join(root, "conf"), userDataRoot: join(root, "data") },
  });
  try {
    // When the plugin trust service writes through its resolved PathsService.
    const file = await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* PluginTrustStore).trustPlugin("@example/root-proof");
        return (yield* PathsService).pluginTrustFile;
      }).pipe(Effect.provide(Layer.merge(configLayer, trustLayer.pipe(Layer.provide(configLayer))))),
    );
    // Then the trust file is owned by that runtime's userConfRoot.
    expect(file.startsWith(join(root, "conf"))).toBe(true);
    expect(await Bun.file(file).text()).toContain("@example/root-proof");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
