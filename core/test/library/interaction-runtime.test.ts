import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { initApp } from "../../src/cli/commands/init.ts";
import { makePromiseInteractionPrompter } from "../../src/interaction/prompter.ts";
import { withInteractionServiceOverride } from "../../src/interaction/testing-override.ts";
import { makeTestInteractionService } from "../../src/testing/interaction.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-interaction-lib-")));
  const previousCwd = process.cwd();
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

describe("embedding host drives apps:init non-interactively with TestInteractionService", () => {
  test("seeded answers scaffold an app with zero terminal access", async () => {
    await withTempCwd(async (dir) => {
      const interaction = makeTestInteractionService({
        answers: { name: "lib-app", php: "8.3" },
      });
      const prompter = makePromiseInteractionPrompter(interaction.service);

      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "lamp",
        interaction: prompter,
        postInitIO: { out: () => {}, err: () => {} },
      });

      expect(result.appName).toBe("lib-app");
      expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(true);
      const names = interaction.transcript().map((entry) => entry.name);
      expect(names).toContain("name");
    });
  });

  test("default init prompter honors an active InteractionService override", async () => {
    await withTempCwd(async (dir) => {
      const interaction = makeTestInteractionService({
        answers: { name: "override-app", php: "8.3" },
      });

      const result = await withInteractionServiceOverride(interaction.service, () =>
        initApp({
          cwd: dir,
          full: false,
          recipe: "lamp",
          postInitIO: { out: () => {}, err: () => {} },
        }),
      );

      expect(result.appName).toBe("override-app");
      expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(true);
      const names = interaction.transcript().map((entry) => entry.name);
      expect(names).toContain("name");
    });
  });
});
