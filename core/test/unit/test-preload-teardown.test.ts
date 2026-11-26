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

const writeFixture = (dir: string, name: string, source: string): string => {
  const file = join(dir, name);
  writeFileSync(file, source);
  return file;
};

const printRootSource = `import { test } from "bun:test";
test("print root", () => {
  console.log("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? ""));
});
`;

const parseRoot = (stdout: string): string => {
  const match = /ROOT=(.+)/.exec(stdout);
  const root = match?.[1]?.trim() ?? "";
  expect(root.startsWith(treePrefix)).toBe(true);
  return root;
};

const treeOf = (root: string): string => dirname(root);

// Only Linux exposes the full `bun test` invocation, so other hosts keep the tree.
const releasesTree = process.platform === "linux";
const expectReleased = (tree: string): void => {
  expect(existsSync(tree)).toBe(!releasesTree);
  rmSync(tree, { recursive: true, force: true });
};

describe("test preload root teardown", () => {
  test("serial passing file removes the tree after exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-pass-"));
    try {
      const file = writeFixture(dir, "pass.test.ts", printRootSource);
      const child = Bun.spawnSync([process.execPath, "test", file], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expectReleased(treeOf(parseRoot(child.stdout.toString())));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serial failing file removes the tree after exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-fail-"));
    try {
      const file = writeFixture(
        dir,
        "fail.test.ts",
        `import { test } from "bun:test";
test("fail", () => {
  process.stdout.write("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? "") + "\\n");
  throw new Error("boom");
});
`,
      );
      const child = Bun.spawnSync([process.execPath, "test", file], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).not.toBe(0);
      expectReleased(treeOf(parseRoot(child.stdout.toString())));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two files in one process share a tree until the process exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-two-"));
    try {
      const first = writeFixture(dir, "a.test.ts", printRootSource);
      const second = writeFixture(
        dir,
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
      const child = Bun.spawnSync([process.execPath, "test", first, second], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const stdout = child.stdout.toString();
      const roots = [...stdout.matchAll(/ROOT=(.+)/g)].map((match) => match[1]?.trim() ?? "");
      expect(roots).toHaveLength(2);
      expect(roots[0]).toBe(roots[1]);
      expect(stdout).toContain("PRESENT=true");
      const firstRoot = roots[0];
      if (firstRoot === undefined) throw new Error("expected a printed root");
      expectReleased(treeOf(firstRoot));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nested bun test does not delete the parent's tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-nested-"));
    try {
      const inner = writeFixture(dir, "inner.test.ts", printRootSource);
      const outer = writeFixture(
        dir,
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
      const child = Bun.spawnSync([process.execPath, "test", outer], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const stdout = child.stdout.toString();
      const roots = [...stdout.matchAll(/ROOT=(.+)/g)].map((match) => match[1]?.trim() ?? "");
      expect(roots).toHaveLength(2);
      expect(roots[0]).toBe(roots[1]);
      expect(stdout).toContain("STILL=true");
      const firstRoot = roots[0];
      if (firstRoot === undefined) throw new Error("expected a printed root");
      expectReleased(treeOf(firstRoot));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caller-set root is never removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-caller-"));
    const caller = join(dir, "caller");
    mkdirSync(caller);
    const sentinel = join(caller, "keep");
    writeFileSync(sentinel, "stay");
    try {
      const file = writeFixture(
        dir,
        "caller.test.ts",
        `import { test } from "bun:test";
test("print roots", () => {
  process.stdout.write("ROOT=" + (process.env.LANDO_USER_DATA_ROOT ?? "") + "\\n");
  process.stdout.write("CACHE=" + (process.env.LANDO_USER_CACHE_ROOT ?? "") + "\\n");
});
`,
      );
      const child = Bun.spawnSync([process.execPath, "test", file], {
        cwd: repoRoot,
        env: childEnv({ LANDO_USER_DATA_ROOT: caller }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const stdout = child.stdout.toString();
      expect(stdout).toContain(`ROOT=${caller}`);
      expect(existsSync(sentinel)).toBe(true);
      const cache = /CACHE=(.+)/.exec(stdout)?.[1]?.trim() ?? "";
      expect(cache.startsWith(treePrefix)).toBe(true);
      expectReleased(treeOf(cache));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("LANDO_TEST_USE_REAL_ROOTS=1 does not create a lando-test-roots tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-real-"));
    try {
      const file = writeFixture(dir, "real.test.ts", printRootSource);
      const child = Bun.spawnSync([process.execPath, "test", file], {
        cwd: repoRoot,
        env: childEnv({ LANDO_TEST_USE_REAL_ROOTS: "1" }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const root = /ROOT=(.*)/.exec(child.stdout.toString())?.[1] ?? "";
      expect(root.startsWith(treePrefix)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parallel workers skip deletion so a reused worker keeps the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-parallel-"));
    const record = (name: string) => `import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "bun:test";
test("record root", () => {
  const root = process.env.LANDO_USER_DATA_ROOT ?? "";
  writeFileSync(${JSON.stringify(join(dir, name))}, dirname(root));
});
`;
    try {
      const first = writeFixture(dir, "a.test.ts", record("tree-a"));
      const second = writeFixture(dir, "b.test.ts", record("tree-b"));
      const child = Bun.spawnSync([process.execPath, "test", "--parallel=2", first, second], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0);
      const recorded = [
        ...new Set(
          [join(dir, "tree-a"), join(dir, "tree-b")]
            .filter((file) => existsSync(file))
            .map((file) => readFileSync(file, "utf8"))
            .filter((tree) => tree.length > 0),
        ),
      ];
      expect(recorded.length).toBeGreaterThan(0);
      for (const tree of recorded) {
        expect(existsSync(tree)).toBe(true);
        rmSync(tree, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([["--isolate"], ["--rerun-each=2"], ["--bail=1"]])("%s keeps the tree", (flag) => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-flag-"));
    try {
      const first = writeFixture(dir, "a.test.ts", printRootSource);
      const second = writeFixture(dir, "b.test.ts", printRootSource);
      const child = Bun.spawnSync([process.execPath, "test", flag, first, second], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0);
      const tree = treeOf(parseRoot(child.stdout.toString()));
      expect(existsSync(tree)).toBe(true);
      rmSync(tree, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guide wrapper removes its owned tree after the child is reaped", () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-teardown-wrapper-"));
    try {
      const file = writeFixture(dir, "guide.test.ts", printRootSource);
      const child = Bun.spawnSync([process.execPath, wrapper, file], {
        cwd: repoRoot,
        env: childEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0);
      const tree = treeOf(parseRoot(`${child.stdout}${child.stderr}`));
      expect(existsSync(tree)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runner-owned test roots", () => {
  const rootsOf = (env: Readonly<Record<string, string | undefined>>) => rootEnvKeys.map((key) => env[key]);

  test("fills only unset keys under one tree that lasts until run settles, then removes it", async () => {
    const caller = mkdtempSync(join(tmpdir(), "lando-runner-caller-"));
    const env = { ...childEnv(), LANDO_USER_DATA_ROOT: caller };
    try {
      const seen = await withRunnerOwnedTestRoots({ env, live: false }, async (child) => ({
        roots: rootsOf(child),
        present: existsSync(dirname(child.LANDO_USER_CACHE_ROOT ?? "")),
      }));
      const [data, ...filled] = seen.roots;
      expect(data).toBe(caller);
      const trees = new Set(filled.map((root) => dirname(root ?? "")));
      expect(trees.size).toBe(1);
      const [tree = ""] = trees;
      expect(tree.startsWith(treePrefix)).toBe(true);
      expect(seen.present).toBe(true);
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(caller)).toBe(true);
      expect(rootsOf(env)).toEqual([caller, undefined, undefined, undefined]);
    } finally {
      rmSync(caller, { recursive: true, force: true });
    }
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
