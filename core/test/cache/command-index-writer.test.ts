import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { rememberLocalIncludePaths } from "@lando/landofile/include-provenance";
import { ServiceName } from "@lando/sdk/schema";

import {
  invalidateAppToolingCaches,
  readFreshAppCommandCacheForCwd,
  writeAppCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";

const withTempCacheRoot = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-command-index-writer-"));
  try {
    return await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

describe("app command cache writer", () => {
  test("invalidates a fresh app command cache when a resolved user include changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "user-include-app");
      const includesRoot = join(cacheRoot, "user-includes");
      const includePath = join(includesRoot, "corp.yml");
      await mkdir(appRoot, { recursive: true });
      await mkdir(includesRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: user-include-app\nincludes:\n  - user:corp.yml\n");
      await writeFile(includePath, "tooling:\n  test:\n    service: app\n");
      const landofile = rememberLocalIncludePaths(
        {
          name: "user-include-app",
          services: { [ServiceName.make("app")]: { type: "node" } },
        },
        [includePath],
      );
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile,
          entries: [{ id: "app:test", summary: "Test", hidden: false, service: "app" }],
          cwd: appRoot,
          cacheRoot,
        }),
      );

      // When
      const fresh = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));
      await writeFile(includePath, "tooling:\n  changed:\n    service: app\n");
      const stale = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(fresh).not.toBeNull();
      expect(stale).toBeNull();
    });
  });

  test("invalidateAppToolingCaches removes service-derived app tooling caches", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = join(cacheRoot, "service-app");
      await mkdir(appRoot, { recursive: true });
      await writeFile(join(appRoot, ".lando.yml"), "name: service-app\nservices:\n  app:\n    type: node\n");
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile: {
            name: "service-app",
            services: { [ServiceName.make("app")]: { type: "node" } },
          },
          entries: [{ id: "app:node", summary: "Node tooling", hidden: false, service: "app" }],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      expect(
        await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot })),
      ).not.toBeNull();

      // When
      await Effect.runPromise(invalidateAppToolingCaches({ cacheRoot }));

      // Then
      expect(await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }))).toBeNull();
    });
  });

  test("invalidateAppToolingCaches only deletes apps/tooling-* directories", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const toolingDir = join(cacheRoot, "apps", "tooling-abcdef012345");
      const otherDir = join(cacheRoot, "apps", "myapp-abcdef012345");
      await mkdir(toolingDir, { recursive: true });
      await mkdir(otherDir, { recursive: true });
      await writeFile(join(toolingDir, "commands.bin"), "tooling");
      await writeFile(join(otherDir, "commands.bin"), "app");

      // When
      await Effect.runPromise(invalidateAppToolingCaches({ cacheRoot }));

      // Then
      expect(await Bun.file(join(toolingDir, "commands.bin")).exists()).toBe(false);
      expect(await Bun.file(join(otherDir, "commands.bin")).text()).toBe("app");
    });
  });
});
