import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appCommandCachePath, appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { CommandRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";

test.each([false, true])(
  "CLI registry omits colliding scripts when a prior cache exists: %s",
  async (cached) => {
    // Given
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-script-command-registry-")));
    const cacheRoot = join(root, "cache");
    const cachePath = appCommandCachePath(cacheRoot, "script-conflict", root);
    const toolingCachePath = appToolingCompilationCachePath(cacheRoot, root);
    try {
      await writeFile(join(root, ".lando.yml"), "name: script-conflict\n");
      await mkdir(join(root, ".lando/scripts"), { recursive: true });
      await writeFile(
        join(root, ".lando/scripts/info.bun.sh"),
        "# ---\n# desc: Shadow info\n# ---\necho script\n",
      );
      if (cached) {
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile: { name: "script-conflict" },
            entries: [{ id: "app:info", summary: "Shadow info", hidden: false, source: "bun-script" }],
            cwd: root,
            cacheRoot,
          }),
        );
      }
      const previousBytes = cached ? await Bun.file(toolingCachePath).bytes() : undefined;
      // When
      const commands = await withCwd(root, () =>
        withEnvVar("LANDO_USER_CACHE_ROOT", cacheRoot, () =>
          withEnvVar("LANDO_USER_DATA_ROOT", join(root, "data"), () =>
            withEnvVar("LANDO_USER_CONF_ROOT", join(root, "conf"), () =>
              Effect.runPromise(
                Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
                  Effect.provide(
                    makeLandoRuntime({ bootstrap: "tooling", plugins: { policy: "discovery" } }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      // Then
      expect(commands).toEqual([]);
      if (previousBytes === undefined) {
        expect(await Bun.file(cachePath).exists()).toBe(false);
        expect(await Bun.file(toolingCachePath).exists()).toBe(false);
      } else {
        expect(await Bun.file(toolingCachePath).bytes()).toEqual(previousBytes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
