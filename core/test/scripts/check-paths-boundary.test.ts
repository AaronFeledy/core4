import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkPathsBoundary } from "../../../scripts/check-paths-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => fs.mkdtemp(join(tmpdir(), "lando-paths-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content, "utf8");
};

describe("paths boundary lint gate", () => {
  test("reports hand-rolled root joins for plugins, scratch, and bin", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/cli/bad-plugins.ts",
        'import { join } from "node:path";\nexport const p = (userDataRoot: string) => join(userDataRoot, "plugins");\n',
      );
      await write(
        root,
        "core/src/cli/bad-scratch.ts",
        'import { join } from "node:path";\nexport const s = (userCacheRoot: string) => join(userCacheRoot, "scratch");\n',
      );
      await write(
        root,
        "plugins/some-plugin/src/bad-bin.ts",
        'import { resolve } from "node:path";\nexport const b = (userDataRoot: string) => resolve(userDataRoot, "bin");\n',
      );

      const result = await checkPathsBoundary({ root });

      expect(result.ok).toBe(false);
      expect(result.offenders.map((offender) => relative(root, offender.file).replaceAll("\\", "/"))).toEqual(
        ["core/src/cli/bad-plugins.ts", "core/src/cli/bad-scratch.ts", "plugins/some-plugin/src/bad-bin.ts"],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("passes for primitive-routed builders and unrelated joins", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/config/paths.ts",
        'import { join } from "node:path";\nexport const make = (userDataRoot: string) => join(userDataRoot, "plugins");\n',
      );
      await write(
        root,
        "core/src/cli/clean.ts",
        'import { makeLandoPaths } from "../config/paths.ts";\nexport const p = (userDataRoot: string) => makeLandoPaths({ userDataRoot }).pluginsDir;\n',
      );
      await write(
        root,
        "plugins/some-plugin/src/unrelated.ts",
        'import { join } from "node:path";\nexport const a = (appRoot: string) => join(appRoot, "plugins");\nexport const c = (userDataRoot: string) => join(userDataRoot, "certs");\n',
      );
      await write(
        root,
        "core/src/cli/fixture.test.ts",
        'import { join } from "node:path";\nexport const t = (userDataRoot: string) => join(userDataRoot, "plugins");\n',
      );

      expect(await checkPathsBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
