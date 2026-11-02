import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const rootEnvKeys = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;
const preload = resolve(import.meta.dirname, "../../../scripts/test-preload.ts");
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
