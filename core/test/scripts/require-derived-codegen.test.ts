import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  DERIVED_CODEGEN_SENTINELS,
  assertDerivedCodegen,
  derivedCodegenMessage,
  isModuleResolveError,
  missingDerivedCodegen,
} from "../../bin/derived-codegen.ts";

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

  test("isModuleResolveError matches Bun cannot-find-module messages without path shape", () => {
    // Given: Bun's recipes resolve failure and a non-resolve error.
    const recipesMsg =
      "Cannot find module './bundled' imported from …/core/src/recipes/catalog.ts";
    const other = new Error("something else failed");

    // When / Then: only the module-resolve shape is true.
    expect(isModuleResolveError(new Error(recipesMsg))).toBe(true);
    expect(isModuleResolveError(other)).toBe(false);
    expect(isModuleResolveError("Cannot find module")).toBe(false);
  });

  test(
    "bun test in a minimal tree without sentinels fails closed via preload",
    async () => {
      // Given: a minimal package that reuses the real guard + preload, no sentinels.
      const root = await mkdtemp(join(tmpdir(), "lando-derived-codegen-proc-"));
      roots.push(root);
      const scriptsDir = join(root, "scripts");
      const coreBinDir = join(root, "core/bin");
      await mkdir(scriptsDir, { recursive: true });
      await mkdir(coreBinDir, { recursive: true });
      await mkdir(join(root, "test"), { recursive: true });

      const repoRoot = resolve(import.meta.dirname, "../../..");
      await writeFile(
        join(root, "bunfig.toml"),
        '[test]\npreload = ["./scripts/require-derived-codegen-preload.ts"]\n',
        "utf8",
      );
      await Bun.write(
        join(root, "core/bin/derived-codegen.ts"),
        Bun.file(join(repoRoot, "core/bin/derived-codegen.ts")),
      );
      await Bun.write(
        join(root, "scripts/require-derived-codegen-preload.ts"),
        Bun.file(join(repoRoot, "scripts/require-derived-codegen-preload.ts")),
      );
      await writeFile(
        join(root, "test/smoke.test.ts"),
        'import { test, expect } from "bun:test";\ntest("smoke", () => expect(true).toBe(true));\n',
        "utf8",
      );

      // When: bun test runs under that tree's preload.
      const proc = Bun.spawn([process.execPath, "test", "test/smoke.test.ts"], {
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

      // Then: nonzero exit and all-missing remediation on stderr.
      expect(exitCode).not.toBe(0);
      const combined = `${stderr}\n${stdout}`;
      expect(combined).toContain("Run `bun run codegen`");
      expect(combined).toContain("(8 of 8)");
    },
    { timeout: 30_000 },
  );

  test("bunfig.toml preload starts with require-derived-codegen-preload", async () => {
    // Given: the repo bunfig.toml test preload list.
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const bunfig = await Bun.file(join(repoRoot, "bunfig.toml")).text();
    const match = bunfig.match(/\[test\][\s\S]*?preload\s*=\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const entries = (match?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry.length > 0);

    // When / Then: first preload is the codegen guard.
    expect(entries[0]?.endsWith("require-derived-codegen-preload.ts")).toBe(true);
  });

  test("test-preload awaits bundled-plugins dynamically after the guard", async () => {
    // Given: scripts/test-preload.ts source.
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const source = await Bun.file(join(repoRoot, "scripts/test-preload.ts")).text();

    // When / Then: dynamic import only; no static bundled-plugins import.
    expect(source).toMatch(/await import\(["']\.\.\/core\/src\/runtime\/bundled-plugins/);
    expect(source).not.toContain('import "../core/src/runtime/bundled-plugins');
  });

  test("every derived-codegen sentinel path is gitignored", async () => {
    // Given: the eight sentinel relative paths at the repo root.
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const input = `${DERIVED_CODEGEN_SENTINELS.join("\n")}\n`;

    // When: git check-ignore --stdin echoes ignored paths.
    const proc = Bun.spawn(["git", "check-ignore", "--stdin"], {
      cwd: repoRoot,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Then: all eight paths echo back (fully ignored).
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const echoed = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(echoed).toEqual([...DERIVED_CODEGEN_SENTINELS]);
  });
});
