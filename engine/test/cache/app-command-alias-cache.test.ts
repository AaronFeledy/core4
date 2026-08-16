import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { rememberLandofileReferencedFiles } from "@lando/landofile/load-expression-provenance";
import {
  readFreshAppCommandCacheForCwd,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { deriveAppCommandToolingFingerprint } from "../../src/cache/command-index.ts";
import { appToolingCompilationCachePath } from "../../src/cache/paths.ts";

const withTempCacheRoot = async <T>(run: (cacheRoot: string) => Promise<T>): Promise<T> => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-command-alias-cache-"));
  try {
    return await run(cacheRoot);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const makeAppRoot = async (cacheRoot: string, name: string): Promise<string> => {
  const appRoot = join(cacheRoot, name);
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(appRoot, ".lando.yml"), `name: ${name}\n`);
  return appRoot;
};

describe("writeAppCommandCacheStrict command alias policy", () => {
  test("invalidates cached aliases when a referenced file changes", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = await makeAppRoot(cacheRoot, "referenced-alias-app");
      const targetPath = join(appRoot, "alias-target.txt");
      const initialTarget = "app:known";
      await writeFile(targetPath, initialTarget);
      const targetStats = await stat(targetPath);
      const landofile = rememberLandofileReferencedFiles(
        { name: "referenced-alias-app", commandAliases: { custom: { hi: initialTarget } } },
        [
          {
            absolutePath: targetPath,
            mtimeMs: targetStats.mtimeMs,
            size: targetStats.size,
            sha256: createHash("sha256").update(initialTarget).digest("hex"),
          },
        ],
      );
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile,
          entries: [{ id: "app:known", summary: "Known task", hidden: false }],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      expect(
        await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot })),
      ).not.toBeNull();

      // When
      await writeFile(targetPath, "app:other");

      // Then
      expect(await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }))).toBeNull();
    });
  });

  test("persists a normalized policy on a fresh app command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = await makeAppRoot(cacheRoot, "alias-app");
      const landofile = {
        name: "alias-app",
        commandAliases: {
          disabled: ["stop", "stop"],
          custom: { zed: "app:known", hi: "app:known" },
        },
      };

      // When
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile,
          entries: [{ id: "app:known", summary: "Known task", hidden: false }],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      const payload = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(payload?.aliasPolicy).toEqual({
        enabled: true,
        disabled: ["stop"],
        custom: { hi: "app:known", zed: "app:known" },
      });
    });
  });

  test("refreshes alias policy when reusing an otherwise fresh command cache", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = await makeAppRoot(cacheRoot, "alias-reuse-app");
      const landofile = {
        name: "alias-reuse-app",
        commandAliases: { enabled: false, custom: { hi: "app:known" } },
      };
      const entries = [{ id: "app:known", summary: "Known task", hidden: false }] as const;
      await Effect.runPromise(
        writeAppCommandCacheStrict({ landofile, entries, cwd: appRoot, cacheRoot, now: () => 41 }),
      );
      await rm(appToolingCompilationCachePath(cacheRoot, appRoot));

      // When
      await Effect.runPromise(
        writeAppCommandCacheStrict({ landofile, entries, cwd: appRoot, cacheRoot, now: () => 99 }),
      );
      const payload = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(payload?.generatedAtMs).toBe(41);
      expect(payload?.aliasPolicy).toEqual({
        enabled: false,
        disabled: [],
        custom: { hi: "app:known" },
      });
    });
  });

  test("includes command aliases in the semantic tooling fingerprint", () => {
    // Given
    const base = { name: "alias-fingerprint" };

    // When
    const withoutAliases = deriveAppCommandToolingFingerprint(base);
    const withAliases = deriveAppCommandToolingFingerprint({
      ...base,
      commandAliases: { custom: { hi: "app:known" } },
    });

    // Then
    expect(withAliases).not.toBe(withoutAliases);
  });

  test("omits alias policy when the Landofile has no commandAliases section", async () => {
    await withTempCacheRoot(async (cacheRoot) => {
      // Given
      const appRoot = await makeAppRoot(cacheRoot, "no-alias-app");

      // When
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile: { name: "no-alias-app" },
          entries: [],
          cwd: appRoot,
          cacheRoot,
        }),
      );
      const payload = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));

      // Then
      expect(payload).not.toHaveProperty("aliasPolicy");
    });
  });
});
