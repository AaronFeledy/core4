import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withRunnerOwnedTestRoots } from "../../../scripts/test-preload-roots.ts";

const rootEnvKeys = [
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;
const repoRoot = resolve(import.meta.dirname, "../../..");
const treePrefix = join(tmpdir(), "lando-test-roots-");
const wrapper = join(repoRoot, "scripts/test-reporters/run-guide-scenarios.ts");

const childEnv = (overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of [...rootEnvKeys, "LANDO_TEST_USE_REAL_ROOTS"]) delete env[key];
  return { ...env, ...overrides };
};

const tempDir = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }) };
};

const writeFixture = (dir: string, name: string, source: string): string => {
  const file = join(dir, name);
  writeFileSync(file, source);
  return file;
};

const spawn = (cmd: readonly string[], env: NodeJS.ProcessEnv = childEnv()) => {
  const child = Bun.spawnSync([...cmd], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  const stdout = child.stdout.toString();
  return { exitCode: child.exitCode, stdout, output: `${stdout}\n${child.stderr}` };
};

const printRootSource = `import { test } from "bun:test";
test("print root", () => {
  console.log("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? ""));
});
`;

/** Every `ROOT=` line a fixture printed; at least one, each inside a preload tree. */
const printedRoots = (output: string): string[] => {
  const roots = [...output.matchAll(/ROOT=(.+)/g)].map((match) => match[1]?.trim() ?? "");
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) expect(root.startsWith(treePrefix)).toBe(true);
  return roots;
};

// Only Linux exposes the full `bun test` invocation, so other hosts keep the tree.
const releasesTree = process.platform === "linux";
const expectReleased = (tree: string): void => {
  expect(existsSync(tree)).toBe(!releasesTree);
  rmSync(tree, { recursive: true, force: true });
};

describe("test preload root teardown", () => {
  test.each([
    { name: "passing", passes: true, source: printRootSource },
    {
      name: "failing",
      passes: false,
      source: `import { test } from "bun:test";
test("fail", () => {
  process.stdout.write("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? "") + "\\n");
  throw new Error("boom");
});
`,
    },
  ])("serial $name file removes the tree after exit", ({ passes, source }) => {
    using dir = tempDir("lando-teardown-serial-");
    const child = spawn([process.execPath, "test", writeFixture(dir.path, "serial.test.ts", source)]);
    expect(child.exitCode === 0, child.output).toBe(passes);
    const [root = ""] = printedRoots(child.stdout);
    expectReleased(dirname(root));
  });

  test("two files in one process share a tree until the process exits", () => {
    using dir = tempDir("lando-teardown-two-");
    const first = writeFixture(dir.path, "a.test.ts", printRootSource);
    const second = writeFixture(
      dir.path,
      "b.test.ts",
      `import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "bun:test";
test("second still sees the tree", () => {
  const root = process.env.LANDO_USER_DATA_ROOT ?? "";
  process.stdout.write("ROOT=" + root + "\\n");
  process.stdout.write("PRESENT=" + existsSync(dirname(root)) + "\\n");
});
`,
    );
    const child = spawn([process.execPath, "test", first, second]);
    expect(child.exitCode, child.output).toBe(0);
    const roots = printedRoots(child.stdout);
    const [root = ""] = roots;
    expect(roots).toEqual([root, root]);
    expect(child.stdout).toContain("PRESENT=true");
    expectReleased(dirname(root));
  });

  test("nested bun test does not delete the parent's tree", () => {
    using dir = tempDir("lando-teardown-nested-");
    const inner = writeFixture(dir.path, "inner.test.ts", printRootSource);
    const outer = writeFixture(
      dir.path,
      "outer.test.ts",
      `import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "bun:test";
test("nested child inherits and parent keeps the tree", () => {
  const root = process.env.LANDO_USER_DATA_ROOT ?? "";
  process.stdout.write("ROOT=" + root + "\\n");
  const inner = Bun.spawnSync(${JSON.stringify([process.execPath, "test", inner])}, {
    cwd: ${JSON.stringify(repoRoot)},
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdout.write(inner.stdout.toString());
  process.stdout.write("STILL=" + existsSync(dirname(root)) + "\\n");
});
`,
    );
    const child = spawn([process.execPath, "test", outer]);
    expect(child.exitCode, child.output).toBe(0);
    const roots = printedRoots(child.stdout);
    const [root = ""] = roots;
    expect(roots).toEqual([root, root]);
    expect(child.stdout).toContain("STILL=true");
    expectReleased(dirname(root));
  });

  test("caller-set root is never removed", () => {
    using dir = tempDir("lando-teardown-caller-");
    const caller = join(dir.path, "caller");
    mkdirSync(caller);
    const sentinel = join(caller, "keep");
    writeFileSync(sentinel, "stay");
    const file = writeFixture(
      dir.path,
      "caller.test.ts",
      `import { test } from "bun:test";
test("print roots", () => {
  process.stdout.write("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? "") + "\\n");
  process.stdout.write("CACHE=" + (process.env.LANDO_USER_CACHE_ROOT ?? "") + "\\n");
});
`,
    );
    const child = spawn([process.execPath, "test", file], childEnv({ LANDO_USER_DATA_ROOT: caller }));
    expect(child.exitCode, child.output).toBe(0);
    expect(child.stdout).toContain(`ROOT=${caller}`);
    expect(existsSync(sentinel)).toBe(true);
    const cache = /CACHE=(.+)/.exec(child.stdout)?.[1]?.trim() ?? "";
    expect(cache.startsWith(treePrefix)).toBe(true);
    expectReleased(dirname(cache));
  });

  test("parallel workers skip deletion so a reused worker keeps the tree", () => {
    using dir = tempDir("lando-teardown-parallel-");
    const record = (name: string) => `import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "bun:test";
test("record root", () => {
  writeFileSync(${JSON.stringify(join(dir.path, name))}, dirname(process.env.LANDO_USER_DATA_ROOT ?? ""));
});
`;
    const first = writeFixture(dir.path, "a.test.ts", record("tree-a"));
    const second = writeFixture(dir.path, "b.test.ts", record("tree-b"));
    const child = spawn([process.execPath, "test", "--parallel=2", first, second]);
    expect(child.exitCode, child.output).toBe(0);
    const trees = new Set(["tree-a", "tree-b"].map((name) => readFileSync(join(dir.path, name), "utf8")));
    for (const tree of trees) {
      expect(tree.startsWith(treePrefix)).toBe(true);
      expect(existsSync(tree)).toBe(true);
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test.each([["--isolate"], ["--rerun-each=2"], ["--bail=1"]])("%s keeps the tree", (flag) => {
    using dir = tempDir("lando-teardown-flag-");
    const first = writeFixture(dir.path, "a.test.ts", printRootSource);
    const second = writeFixture(dir.path, "b.test.ts", printRootSource);
    const child = spawn([process.execPath, "test", flag, first, second]);
    expect(child.exitCode, child.output).toBe(0);
    // --isolate gives each file a fresh env and so its own tree; remove every one.
    const trees = new Set(printedRoots(child.stdout).map((root) => dirname(root)));
    for (const tree of trees) {
      expect(existsSync(tree)).toBe(true);
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test("guide wrapper removes its owned tree after the child is reaped", () => {
    using dir = tempDir("lando-teardown-wrapper-");
    const child = spawn([
      process.execPath,
      wrapper,
      writeFixture(dir.path, "guide.test.ts", printRootSource),
    ]);
    expect(child.exitCode, child.output).toBe(0);
    const [root = ""] = printedRoots(child.output);
    expect(existsSync(dirname(root))).toBe(false);
  });
});

describe("runner-owned test roots", () => {
  const rootsOf = (env: Readonly<Record<string, string | undefined>>) => rootEnvKeys.map((key) => env[key]);

  test("fills only unset keys under one tree that lasts until run settles, then removes it", async () => {
    using caller = tempDir("lando-runner-caller-");
    const env = { ...childEnv(), LANDO_USER_DATA_ROOT: caller.path };
    const seen = await withRunnerOwnedTestRoots({ env, live: false }, async (child) => ({
      roots: rootsOf(child),
      present: existsSync(dirname(child.LANDO_USER_CACHE_ROOT ?? "")),
    }));
    const [data, ...filled] = seen.roots;
    expect(data).toBe(caller.path);
    const trees = new Set(filled.map((root) => dirname(root ?? "")));
    expect(trees.size).toBe(1);
    const [tree = ""] = trees;
    expect(tree.startsWith(treePrefix)).toBe(true);
    expect(seen.present).toBe(true);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(caller.path)).toBe(true);
    expect(rootsOf(env)).toEqual([caller.path, undefined, undefined, undefined]);
  });

  test("removes the tree when run rejects", async () => {
    let tree = "";
    const failed = withRunnerOwnedTestRoots({ env: childEnv(), live: false }, async (child) => {
      tree = dirname(child.LANDO_USER_DATA_ROOT ?? "");
      throw new Error("child failed");
    });
    await expect(failed).rejects.toThrow("child failed");
    expect(tree.startsWith(treePrefix)).toBe(true);
    expect(existsSync(tree)).toBe(false);
  });

  test.each([
    { name: "a live run", env: childEnv(), live: true },
    { name: "LANDO_TEST_USE_REAL_ROOTS=1", env: childEnv({ LANDO_TEST_USE_REAL_ROOTS: "1" }), live: false },
    {
      name: "caller-set roots",
      env: childEnv(Object.fromEntries(rootEnvKeys.map((key) => [key, join(tmpdir(), "caller", key)]))),
      live: false,
    },
  ])("hands $name its roots unchanged", async ({ env, live }) => {
    const roots = await withRunnerOwnedTestRoots({ env, live }, async (child) => rootsOf(child));
    expect(roots).toEqual(rootsOf(env));
  });
});
