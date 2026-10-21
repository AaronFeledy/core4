import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, PluginLoadError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, PluginRegistry } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint";

test.each([0, 1])(
  "preserves ConfigError when global config fails after %i successful loads",
  async (successfulLoads) => {
    // Given valid app syntax and a global-config failure on either lint pass.
    const root = await mkdtemp(join(tmpdir(), "lando-lint-config-error-"));
    const error = new ConfigError({
      message: "Invalid global configuration.",
      path: join(root, "config.yml"),
      issues: [{ path: ["router", "httpPort"], message: "Invalid port." }],
      remediation: "Run `lando config validate`.",
    });
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    let reads = 0;
    const load = Effect.suspend(() =>
      reads++ < successfulLoads ? Effect.succeed(config) : Effect.fail(error),
    );
    const unavailable = (pluginName: string) =>
      Effect.fail(new PluginLoadError({ message: "Not registered.", pluginName }));
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
          appConfigLint({ cwd: root }).pipe(
            Effect.provideService(PluginRegistry, plugins),
            Effect.provideService(
              ConfigService,
              ConfigService.of({ load, get: (key) => Effect.map(load, (value) => value[key]) }),
            ),
          ),
        ),
      );
      // Then neither pass converts global-config failure into an app violation.
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBe(error);
      expect(reads).toBe(successfulLoads + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
