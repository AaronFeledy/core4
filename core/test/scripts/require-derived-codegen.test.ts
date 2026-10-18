import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  DERIVED_CODEGEN_SENTINELS,
  assertDerivedCodegen,
  derivedCodegenMessage,
  missingDerivedCodegen,
} from "../../../scripts/require-derived-codegen.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeSentinel = async (root: string, relative: string): Promise<void> => {
  const absolute = join(root, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, "// sentinel\n", "utf8");
};

describe("require-derived-codegen", () => {
  test("missing list names the absent sentinel when 7 of 8 exist", async () => {
    // Given: a temp tree with every sentinel except one.
    const root = await mkdtemp(join(tmpdir(), "lando-derived-codegen-"));
    roots.push(root);
    const [absent, ...present] = DERIVED_CODEGEN_SENTINELS;
    if (absent === undefined) throw new Error("expected sentinels");
    for (const relative of present) {
      await writeSentinel(root, relative);
    }

    // When: missingDerivedCodegen scans the tree.
    const missing = missingDerivedCodegen(root);
    const message = derivedCodegenMessage(missing);

    // Then: only the absent path is reported and remediation names codegen.
    expect(missing).toEqual([absent]);
    expect(message).toContain("bun run codegen");
    expect(message).toContain(absent);
    expect(message).toContain("1 of 8");
  });

  test("assertDerivedCodegen does not throw when all 8 sentinels exist", async () => {
    // Given: a temp tree with every sentinel present.
    const root = await mkdtemp(join(tmpdir(), "lando-derived-codegen-"));
    roots.push(root);
    for (const relative of DERIVED_CODEGEN_SENTINELS) {
      await writeSentinel(root, relative);
    }

    // When / Then: assert passes.
    expect(() => assertDerivedCodegen(root)).not.toThrow();
    expect(missingDerivedCodegen(root)).toEqual([]);
  });

  test(
    "bun test in a minimal tree without sentinels fails closed via preload",
    async () => {
      // Given: a minimal package that reuses the real guard + preload, no sentinels.
      const root = await mkdtemp(join(tmpdir(), "lando-derived-codegen-proc-"));
      roots.push(root);
      const scriptsDir = join(root, "scripts");
      await mkdir(scriptsDir, { recursive: true });
      await mkdir(join(root, "test"), { recursive: true });

      const repoScripts = resolve(import.meta.dirname, "../../../scripts");
      await writeFile(
        join(root, "bunfig.toml"),
        '[test]\npreload = ["./scripts/require-derived-codegen-preload.ts"]\n',
        "utf8",
      );
      await Bun.write(
        join(root, "scripts/require-derived-codegen.ts"),
        Bun.file(join(repoScripts, "require-derived-codegen.ts")),
      );
      await Bun.write(
        join(root, "scripts/require-derived-codegen-preload.ts"),
        Bun.file(join(repoScripts, "require-derived-codegen-preload.ts")),
      );
      await writeFile(
        join(root, "test/smoke.test.ts"),
        'import { test, expect } from "bun:test";\ntest("smoke", () => expect(true).toBe(true));\n',
        "utf8",
      );

      // When: bun test runs under that tree's preload.
      const proc = Bun.spawn(["bun", "test", "test/smoke.test.ts"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // Then: nonzero exit and actionable codegen remediation on stderr.
      expect(exitCode).not.toBe(0);
      expect(`${stderr}\n${stdout}`).toContain("Run `bun run codegen`");
    },
    { timeout: 5_000 },
  );
});
