import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectImportBoundaryViolations } from "@lando/sdk/test";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");

describe("@lando/file-sync-mutagen import boundary", () => {
  test("does not import @lando/core, OCLIF, core CLI internals, or undeclared plugins", async () => {
    expect(await collectImportBoundaryViolations({ packageRoot: PACKAGE_ROOT })).toEqual([]);
  });

  test("helper flags forbidden @lando/core import in a fixture package", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "import-boundary-"));
    try {
      const srcDir = path.join(fixtureRoot, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(
        path.join(fixtureRoot, "package.json"),
        JSON.stringify({ name: "@lando/fixture-plugin", dependencies: { "@lando/sdk": "workspace:*" } }),
      );
      await writeFile(
        path.join(srcDir, "bad.ts"),
        'import type { Something } from "@lando/core/cli";\nexport const x = 1;\n',
      );

      const violations = await collectImportBoundaryViolations({ packageRoot: fixtureRoot });

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.specifier.startsWith("@lando/core"))).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
