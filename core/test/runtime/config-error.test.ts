import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@lando/sdk/errors";
import { Effect, Layer } from "effect";
import { makeLandoRuntime } from "../../src/runtime/layer";
import { withEnvVar } from "../_support/temp-cwd";

test.each(["minimal", "plugins", "commands", "tooling", "provider", "global", "scratch", "app"] as const)(
  "%s bootstrap preserves invalid ambient config",
  async (bootstrap) => {
    const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-error-"));
    const conf = join(root, "conf");
    await mkdir(conf);
    await writeFile(join(conf, "config.yml"), "router:\n  httpPort: 99999\n");
    try {
      await withEnvVar("LANDO_USER_CONF_ROOT", conf, () =>
        withEnvVar("LANDO_USER_DATA_ROOT", join(root, "data"), () =>
          withEnvVar("LANDO_USER_CACHE_ROOT", join(root, "cache"), async () => {
            const result = await Effect.runPromise(
              Effect.result(
                Effect.scoped(
                  Layer.build(makeLandoRuntime({ bootstrap, plugins: { policy: "bundled-only" } })),
                ),
              ),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag !== "Failure") return;
            expect(result.failure).toBeInstanceOf(ConfigError);
            expect(result.failure).toMatchObject({
              path: join(conf, "config.yml"),
              issues: [
                {
                  path: ["router", "httpPort"],
                  message: expect.any(String),
                  source: {
                    layer: "config-file",
                    file: join(conf, "config.yml"),
                    path: ["router", "httpPort"],
                  },
                },
              ],
              remediation: expect.stringContaining("lando config validate"),
            });
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
