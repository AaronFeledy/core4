import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkRendererBoundary } from "../../../scripts/check-renderer-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-renderer-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("renderer boundary lint gate", () => {
  test("passes when direct writes are confined to explicit carve-outs", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/cli/oclif/pre-renderer.ts", "console.log('first paint');\n");
      await write(root, "core/bin/lando.ts", "process.stdout.write('banner');\n");
      await write(root, "core/src/cli/commands/ok.ts", "export const ok = true;\n");

      expect(await checkRendererBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports source direct writes outside carve-outs", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/recipes/bad.ts", "export const bad = () => console.error('bad');\n");
      await write(root, "core/src/recipes/table.ts", "export const table = () => console.table([]);\n");
      await write(root, "plugins/example/src/bad.ts", "process.stderr.write('bad');\n");

      const result = await checkRendererBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/recipes/bad.ts:1:console.error",
        "core/src/recipes/table.ts:1:console.table",
        "plugins/example/src/bad.ts:1:process.stderr.write",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
