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
    const root = await mkdtemp(join(tmpdir(), "lando-derived-codegen-"));
    roots.push(root);
    const absent = "container-runtime/src/generated/provider-images.ts";
    const present = DERIVED_CODEGEN_SENTINELS.filter((path) => path !== absent);
    for (const relative of present) {
      await writeSentinel(root, relative);
    }
    const missing = missingDerivedCodegen(root);
    const message = derivedCodegenMessage(missing);
    expect(missing).toEqual([absent]);
    expect(message).toContain("bun run codegen");
    expect(message).toContain(absent);
    expect(message).toContain("1 of 8");
  });

  test("assertDerivedCodegen does not throw when all 8 sentinels exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-derived-codegen-"));
    roots.push(root);
    for (const relative of DERIVED_CODEGEN_SENTINELS) {
      await writeSentinel(root, relative);
    }
    expect(() => assertDerivedCodegen(root)).not.toThrow();
    expect(missingDerivedCodegen(root)).toEqual([]);
  });

  test("isModuleResolveError matches Bun cannot-find-module messages without path shape", () => {
    const recipesMsg = "Cannot find module './bundled' imported from …/core/src/recipes/catalog.ts";
    const other = new Error("something else failed");
    expect(isModuleResolveError(new Error(recipesMsg))).toBe(true);
    expect(isModuleResolveError(other)).toBe(false);
    expect(isModuleResolveError("Cannot find module")).toBe(false);
  });

  test(
    "bun test in a minimal tree without sentinels fails closed via preload",
    async () => {
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
      expect(exitCode).not.toBe(0);
      const combined = `${stderr}\n${stdout}`;
      expect(combined).toContain("Run `bun run codegen`");
      expect(combined).toContain("(8 of 8)");
    },
    { timeout: 30_000 },
  );

  test("bunfig.toml preload starts with require-derived-codegen-preload", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const bunfig = await Bun.file(join(repoRoot, "bunfig.toml")).text();
    const match = bunfig.match(/\[test\][\s\S]*?preload\s*=\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const entries = (match?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry.length > 0);
    expect(entries[0]?.endsWith("require-derived-codegen-preload.ts")).toBe(true);
  });

  test("test-preload awaits bundled-plugins dynamically after the guard", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const source = await Bun.file(join(repoRoot, "scripts/test-preload.ts")).text();
    expect(source).toMatch(/await import\(["']\.\.\/core\/src\/runtime\/bundled-plugins/);
    expect(source).not.toContain('import "../core/src/runtime/bundled-plugins');
  });

  test("every derived-codegen sentinel path is gitignored", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const input = `${DERIVED_CODEGEN_SENTINELS.join("\n")}\n`;
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
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const echoed = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(echoed).toEqual([...DERIVED_CODEGEN_SENTINELS]);
  });
});
