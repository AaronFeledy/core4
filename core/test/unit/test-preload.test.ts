import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const rootEnvKeys = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;
const repoRoot = resolve(import.meta.dirname, "../../..");
const preload = join(repoRoot, "scripts/test-preload.ts");
const dumpRoots = `console.log(${JSON.stringify(rootEnvKeys)}.map(key => process.env[key] ?? "<unset>").join("\\n"));`;
const tempRoots = new Set<string>();

const runPreload = (overrides: Readonly<Record<string, string>> = {}): readonly string[] => {
  const env = { ...process.env };
  for (const key of [...rootEnvKeys, "LANDO_TEST_USE_REAL_ROOTS"]) delete env[key];
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(preload)}); ${dumpRoots}
const child = Bun.spawnSync({ cmd: [process.execPath, "-e", ${JSON.stringify(dumpRoots)}], env: { ...process.env }, stdout: "pipe" });
process.stdout.write(child.stdout); process.exit(child.exitCode);`,
    ],
    env: { ...env, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const roots = child.stdout.toString().trim().split("\n");
  for (const root of roots) {
    if (root.startsWith(join(tmpdir(), "lando-test-roots-"))) tempRoots.add(dirname(root));
  }
  return roots;
};

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("preserved symlinks outside tests", () => {
  const run = (cmd: string[], cwd: string, value?: string) => {
    const { NODE_PRESERVE_SYMLINKS: _preserveSymlinks, ...env } = process.env;
    const child = Bun.spawnSync(cmd, {
      cwd,
      env: value === undefined ? env : { ...env, NODE_PRESERVE_SYMLINKS: value },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  };

  test.each([
    { name: "a repo-root bun command with the variable set", cmd: ["-e", "console.log('ran')"], value: "1" },
    {
      name: "a repo-root bun command with --preserve-symlinks",
      cmd: ["--preserve-symlinks", "-e", "console.log('ran')"],
    },
  ])("refuses $name before it runs", ({ cmd, value }) => {
    const child = run([process.execPath, ...cmd], repoRoot, value);
    expect(child.exitCode).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("preserved symlinks");
  });

  test("the source CLI refuses the variable when run from an app folder outside the repo", () => {
    const appDir = mkdtempSync(join(tmpdir(), "lando-source-cli-symlinks-"));
    tempRoots.add(appDir);
    const cli = join(repoRoot, "core/bin/lando.ts");
    const refused = run([process.execPath, cli, "version"], appDir, "1");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("env -u NODE_PRESERVE_SYMLINKS");
    expect(run([process.execPath, cli, "version"], appDir).exitCode).toBe(0);
  });
});

describe("test preload symlink resolution", () => {
  test.each([
    { value: undefined, allowed: true },
    { value: "", allowed: true },
    { value: "0", allowed: true },
    { value: "1", allowed: false },
    { value: "true", allowed: false },
  ])("matches CI with NODE_PRESERVE_SYMLINKS=$value", async ({ value, allowed }) => {
    const root = mkdtempSync(join(tmpdir(), "lando-test-symlinks-"));
    tempRoots.add(root);
    const smokeTest = join(root, "smoke.test.ts");
    const marker = "symlink preload smoke test ran";
    await Bun.write(
      smokeTest,
      `import { test } from "bun:test"; test("smoke", () => { process.stdout.write(${JSON.stringify(marker)}); });`,
    );

    const { NODE_PRESERVE_SYMLINKS: _preserveSymlinks, ...env } = process.env;
    if (value !== undefined) env.NODE_PRESERVE_SYMLINKS = value;
    const child = Bun.spawnSync([process.execPath, "test", smokeTest], {
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = child.stderr.toString();
    expect(child.exitCode, stderr).toBe(allowed ? 0 : 1);
    const smokeOutput = child.stdout
      .toString()
      .split(/\r?\n/)
      .filter((line) => line === marker);
    expect(smokeOutput).toEqual(allowed ? [marker] : []);
  });
});

describe("test preload roots", () => {
  test("isolates roots under one temp tree when no overrides are supplied", () => {
    const roots = runPreload();
    const parentRoots = roots.slice(0, 4);
    expect(parentRoots).toHaveLength(4);
    expect(new Set(parentRoots.map(dirname)).size).toBe(1);
    expect(parentRoots.every((root) => root.startsWith(join(tmpdir(), "lando-test-roots-")))).toBe(true);
    expect(new Set(parentRoots).size).toBe(4);
    expect(roots.slice(4)).toEqual(parentRoots);
  });

  test("uses distinct temp trees when separate processes load the preload", () => {
    const first = runPreload();
    const second = runPreload();
    expect(first[0]).not.toBe(second[0]);
  });

  for (const key of rootEnvKeys) {
    test(`preserves caller roots when ${key} is supplied`, () => {
      const supplied = join(tmpdir(), "caller-root");
      const roots = runPreload({ [key]: supplied });
      const parentRoots = roots.slice(0, 4);
      expect(parentRoots[rootEnvKeys.indexOf(key)]).toBe(supplied);
      const isolated = parentRoots.filter((_, index) => rootEnvKeys[index] !== key);
      expect(isolated).toHaveLength(3);
      expect(isolated.every((root) => root.startsWith(join(tmpdir(), "lando-test-roots-")))).toBe(true);
      expect(new Set(isolated.map(dirname)).size).toBe(1);
      expect(new Set(isolated).size).toBe(3);
      expect(roots.slice(4)).toEqual(parentRoots);
    });
  }

  test("preserves default resolution when real roots are explicitly requested", () => {
    expect(runPreload({ LANDO_TEST_USE_REAL_ROOTS: "1" })).toEqual(Array(8).fill("<unset>"));
  });

  test("still isolates roots when the real-root flag is not 1", () => {
    const roots = runPreload({ LANDO_TEST_USE_REAL_ROOTS: "0" });
    expect(roots.every((root) => root.startsWith(join(tmpdir(), "lando-test-roots-")))).toBe(true);
  });
});

describe("test preload engine composition", () => {
  test("loads bundled plugins only when a test first reads the composition, keeping a value a test installed", () => {
    const roots = mkdtempSync(join(tmpdir(), "lando-test-composition-"));
    tempRoots.add(roots);
    const bundled = join(repoRoot, "core/src/runtime/bundled-plugins.ts");
    const composition = join(repoRoot, "engine/src/composition.ts");
    const script = `await import(${JSON.stringify(preload)});
const loaded = () => require.resolve(${JSON.stringify(bundled)}) in require.cache;
const before = loaded();
const lazy = globalThis.__landoEngineCompositionInputs;
const installed = { bundledPluginModules: [] };
globalThis.__landoEngineCompositionInputs = installed;
const plugins = lazy.bundledPluginModules.length;
const kept = globalThis.__landoEngineCompositionInputs === installed;
globalThis.__landoEngineCompositionInputs = lazy;
const { bundledPluginModules } = await import(${JSON.stringify(composition)});
console.log(JSON.stringify({ before, after: loaded(), plugins, kept, read: bundledPluginModules().length }));`;
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of rootEnvKeys) env[key] = join(roots, key.toLowerCase());
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(result.plugins).toBeGreaterThan(0);
    expect(result.kept).toBe(true);
    expect(result.read).toBe(result.plugins);
  });
});
