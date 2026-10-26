import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, PluginLoadError } from "@lando/sdk/errors";
import { PluginRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint";
import * as ConfigLayer from "../../src/services/config";

test.each([99999, -1])("fails bootstrap before app lint for invalid port %i", async (httpPort) => {
  // Given valid app syntax and a global-config failure on either lint pass.
  const root = await mkdtemp(join(tmpdir(), "lando-lint-config-error-"));
  let entered = false;
  const unavailable = (pluginName: string) =>
    Effect.fail(
      new PluginLoadError({
        message: "Not registered.",
        pluginName,
        remediation: "Install or register the plugin, then retry.",
      }),
    );
  const plugins = PluginRegistry.of({
    list: Effect.succeed([]),
    load: unavailable,
    loadServiceType: unavailable,
    loadServiceFeature: unavailable,
    loadAppFeature: unavailable,
  });
  await writeFile(join(root, ".lando.yml"), "name: x\nservices: {}\n");
  try {
    // When the operation validates and reloads the app.
    const result = await Effect.runPromise(
      Effect.result(
        Effect.andThen(
          Effect.sync(() => {
            entered = true;
          }),
          appConfigLint({ cwd: root }),
        ).pipe(
          Effect.provideService(PluginRegistry, plugins),
          Effect.provide(
            ConfigLayer.layerWith({
              env: {},
              sources: { user: false, env: false },
              host: { router: { httpPort } },
            }),
          ),
        ),
      ),
    );
    // Then neither pass converts global-config failure into an app violation.
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(ConfigError);
      expect(result.failure).toMatchObject({
        issues: [{ path: ["router", "httpPort"], source: { layer: "host", path: ["router", "httpPort"] } }],
      });
    }
    expect(entered).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
