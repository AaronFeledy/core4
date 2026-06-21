import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initApp } from "../../src/cli/commands/init.ts";

const withTempDir = async <T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

describe("initApp destination + runPostInit", () => {
  test("renders into an explicit destination instead of <cwd>/<appName>", async () => {
    await withTempDir("lando-init-cwd-", async (cwd) => {
      await withTempDir("lando-init-dest-", async (destination) => {
        const result = await initApp({
          cwd,
          destination,
          full: false,
          recipe: "empty",
          name: "scratch-empty-abc123",
          nonInteractive: true,
          runPostInit: false,
        });

        expect(result.directory).toBe(destination);
        expect(await fileExists(join(destination, ".lando.yml"))).toBe(true);
        expect(await fileExists(join(cwd, "scratch-empty-abc123", ".lando.yml"))).toBe(false);
        const rendered = await readFile(join(destination, ".lando.yml"), "utf8");
        expect(rendered).toContain("name: scratch-empty-abc123");
      });
    });
  });

  test("runPostInit:false skips the recipe post-init actions", async () => {
    await withTempDir("lando-init-cwd-", async (cwd) => {
      await withTempDir("lando-init-dest-", async (destination) => {
        const result = await initApp({
          cwd,
          destination,
          full: false,
          recipe: "empty",
          name: "scratch-empty-def456",
          nonInteractive: true,
          runPostInit: false,
        });
        expect(result.postInit.executed).toEqual([]);
      });
    });
  });
});
