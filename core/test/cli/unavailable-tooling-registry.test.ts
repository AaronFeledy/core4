import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolingCommands } from "@lando/engine/cache/command-compiler";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import * as CommandRegistryLayer from "@lando/engine/services/command-registry";
import { createRedactor } from "@lando/sdk/secrets";
import { CommandRegistry } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { mcpRegistryWithToolingEntries } from "../../src/cli/commands/meta/mcp";
import * as TestLandofileServiceLayer from "../_support/landofile-layer";
import { withCwd, withEnvVar } from "../_support/temp-cwd";

const landofile = {
  name: "unavailable-tooling",
  tooling: { broken: { wrapper: true }, healthy: { cmd: "echo healthy" } },
} as const;

test.each([false, true])(
  "executable registry excludes unavailable tooling with cached=%s (#2325)",
  async (cached) => {
    const root = await mkdtemp(join(tmpdir(), "lando-unavailable-registry-"));
    const cacheRoot = join(root, "cache");
    try {
      await writeFile(
        join(root, ".lando.yml"),
        "name: unavailable-tooling\ntooling:\n  broken:\n    wrapper: true\n  healthy:\n    cmd: echo healthy\n",
      );
      if (cached)
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile,
            entries: compileToolingCommands(landofile, createRedactor("secrets").redactString, {
              sourcePath: root,
            }),
            cwd: root,
            cacheRoot,
          }),
        );
      const commands = await withCwd(root, () =>
        withEnvVar("LANDO_USER_CACHE_ROOT", cacheRoot, () =>
          withEnvVar("LANDO_USER_DATA_ROOT", join(root, "data"), () =>
            withEnvVar("LANDO_USER_CONF_ROOT", join(root, "conf"), () =>
              Effect.runPromise(
                Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
                  Effect.provide(
                    CommandRegistryLayer.layer.pipe(Layer.provide(TestLandofileServiceLayer.layer)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(commands.map((command) => command.id)).toEqual(["app:healthy"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("MCP projection excludes unavailable tooling while retaining healthy siblings (#2325)", () => {
  const entries = compileToolingCommands(landofile, createRedactor("secrets").redactString, {
    sourcePath: "unavailable-tooling-registry test",
  });
  const registry = mcpRegistryWithToolingEntries({ commandEntries: [] }, entries);
  expect(registry.toolingEntries?.map((entry) => entry.spec.id)).toEqual(["app:healthy"]);
});
