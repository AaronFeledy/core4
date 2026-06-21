import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkManagedFileBoundary } from "../../../scripts/check-managed-file-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-managed-file-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("managed-file boundary lint gate", () => {
  test("passes when ownership-marker logic is confined to core/src/managed-file and tests", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/managed-file/marker.ts", 'const tag = "lando-generated";\n');
      await write(root, "core/src/managed-file/fence.ts", 'const open = ">>> lando:";\n');
      await write(root, "core/src/cli/commands/init.ts", "await service.apply(files);\n");
      await write(root, "core/src/managed-file/service.test.ts", 'expect(c).toContain("lando-generated");\n');

      expect(await checkManagedFileBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a host project-file writer that re-spells the ownership sentinels", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/recipes/bad.ts", 'const line = "# lando-generated:recipe — managed";\n');
      await write(root, "plugins/example/src/fence.ts", 'const open = "# >>> lando:demo >>>";\n');

      const result = await checkManagedFileBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual(["core/src/recipes/bad.ts:1:lando-generated", "plugins/example/src/fence.ts:1:>>> lando:"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
