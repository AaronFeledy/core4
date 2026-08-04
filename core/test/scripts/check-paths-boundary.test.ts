import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { pathsRule } from "../../../scripts/boundary/rules/paths.ts";
import { checkPathsBoundary } from "../../../scripts/check-paths-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => fs.mkdtemp(join(tmpdir(), "lando-paths-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content, "utf8");
};

describe("paths boundary lint gate", () => {
  test("keeps the public gate messages stable", () => {
    expect(pathsRule.passMessage).toBe("Paths boundary check passed.");
    expect(pathsRule.failureHeadline).toBe(
      "Paths boundary check failed. Hand-rolled root joins must use @lando/core/paths (makeLandoPaths) or PathsService.",
    );
  });

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

  test("reports hand-rolled root joins in the former core paths shim carve-out", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/config/paths.ts",
        'import { join } from "node:path";\nexport const make = (userDataRoot: string) => join(userDataRoot, "plugins");\n',
      );

      const result = await checkPathsBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.snippet}`,
        ),
      ).toEqual(['core/src/config/paths.ts:join(userDataRoot, "plugins")']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("ignores private seam package sources outside the core and plugin scope", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "paths/src/paths.ts",
        'import { join } from "node:path";\nexport const make = (userDataRoot: string) => join(userDataRoot, "plugins");\n',
      );
      await write(
        root,
        "paths/src/paths-platform.ts",
        'import { join } from "node:path";\nexport const bin = (userDataRoot: string) => join(userDataRoot, "bin");\n',
      );
      await write(
        root,
        "state-store/src/paths.ts",
        'import { join } from "node:path";\nexport const scratch = (userCacheRoot: string) => join(userCacheRoot, "scratch");\n',
      );

      expect(await checkPathsBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reports snippet text and line for path.join and path.resolve property access", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/cli/prop-join.ts",
        'import path from "node:path";\nexport const p = (userDataRoot: string) => path.join(userDataRoot, "plugins");\n',
      );
      await write(
        root,
        "plugins/x/src/nested.ts",
        'import * as path from "node:path";\nexport const run = (userCacheRoot: string) => {\n  return path.resolve(userCacheRoot, "scratch");\n};\n',
      );

      const result = await checkPathsBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.snippet}`,
        ),
      ).toEqual([
        'core/src/cli/prop-join.ts:2:path.join(userDataRoot, "plugins")',
        'plugins/x/src/nested.ts:3:path.resolve(userCacheRoot, "scratch")',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("matches root identifiers by suffix (e.g. paths.userDataRoot)", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/cli/suffix.ts",
        'import { join } from "node:path";\nexport const p = (paths: { userDataRoot: string }) => join(paths.userDataRoot, "bin");\n',
      );

      const result = await checkPathsBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.snippet}`,
        ),
      ).toEqual(['core/src/cli/suffix.ts:join(paths.userDataRoot, "bin")']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
