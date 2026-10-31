import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { timingRefreshCommand } from "../../../scripts/update-test-timings.ts";

import {
  FAKE_CLIENT_PROVIDER_TESTS,
  NIGHTLY_TIER_TESTS,
  TEST_TIMINGS_FILE,
  UNIT_SHARD_COUNT,
  collectShardedTestFiles,
  isShardedUnitTest,
  localUnitTestCommand,
  localUnitTestCommands,
  runLocalUnitTests,
  shardedUnitTestCommand,
  unitShardCommands,
} from "../../../scripts/test-shards.ts";

import { LOCAL_INTEGRATION_TESTS } from "../../../scripts/test-ownership.ts";

const repoRoot = new URL("../../..", import.meta.url);

describe("test shards", () => {
  test("prints the CI shard commands without running tests", () => {
    expect(UNIT_SHARD_COUNT).toBe(3);
    expect(unitShardCommands()).toEqual([
      "bun run test:unit:shard 1/3",
      "bun run test:unit:shard 2/3",
      "bun run test:unit:shard 3/3",
    ]);
  });

  test("keeps the collector exclusion set", async () => {
    expect(isShardedUnitTest("core/test/cli/foo.integration.test.ts")).toBe(false);
    expect(isShardedUnitTest("core/test/library/api.test.ts")).toBe(false);
    expect(isShardedUnitTest("sdk/test/library/api.test.ts")).toBe(false);
    expect(isShardedUnitTest("core/test/recipes/foo.test.ts")).toBe(false);
    expect(isShardedUnitTest("core/test/cli/init.canonical-recipes.test.ts")).toBe(false);
    for (const path of NIGHTLY_TIER_TESTS) {
      expect(isShardedUnitTest(path)).toBe(false);
    }
    expect(isShardedUnitTest("core/test/cli/setup.test.ts")).toBe(true);
    expect(isShardedUnitTest("plugins/provider-podman/test/desktop.test.ts")).toBe(true);
    expect(isShardedUnitTest("plugins/provider-podman/test/desktop.integration.test.ts")).toBe(false);
    expect(isShardedUnitTest("docs/test/frames.test.ts")).toBe(false);

    const files = await collectShardedTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain("plugins/provider-podman/test/desktop.test.ts");
    expect(files).toContain("scripts/ci-podman-install.test.ts");
    expect(files.some((file) => file.startsWith("docs/test/"))).toBe(false);
    const command = localUnitTestCommand(files);
    expect(command.slice(4)).toEqual(files.map((path) => `./${path}`));
    expect(command.slice(0, 4)).toEqual([process.execPath, "--no-orphans", "test", "--timeout=20000"]);
    expect(files.filter((file) => file.endsWith(".integration.test.ts")).sort()).toEqual(
      [...FAKE_CLIENT_PROVIDER_TESTS, ...LOCAL_INTEGRATION_TESTS].sort(),
    );
    for (const file of FAKE_CLIENT_PROVIDER_TESTS) expect(isShardedUnitTest(file)).toBe(true);
    expect(files.some((file) => file.startsWith("core/test/library/"))).toBe(false);
    expect(files.some((file) => file.startsWith("sdk/test/library/"))).toBe(false);
    expect(files.some((file) => file.startsWith("core/test/recipes/"))).toBe(false);
    expect(files).not.toContain("core/test/cli/init.canonical-recipes.test.ts");
    for (const path of NIGHTLY_TIER_TESTS) {
      expect(files).not.toContain(path);
    }
  });

  test("hands shard balance to bun --shard --timings", async () => {
    expect(shardedUnitTestCommand("1/3")).toEqual([
      process.execPath,
      "--no-orphans",
      "test",
      "--timeout=20000",
      "--shard=1/3",
      `--timings=${TEST_TIMINGS_FILE}`,
    ]);
    expect(shardedUnitTestCommand("2/3", { updateTimings: true })).toEqual([
      process.execPath,
      "--no-orphans",
      "test",
      "--timeout=20000",
      "--shard=2/3",
      `--timings=${TEST_TIMINGS_FILE}`,
      "--update-timings",
    ]);

    const source = await Bun.file(new URL("scripts/test-shards.ts", repoRoot)).text();
    expect(source).not.toContain("WEIGHT_HINTS");
    expect(source).not.toContain("shardFiles");
    expect(source).toContain("--no-orphans");
  });
});

test("bounds Windows command lines while preserving every collected file exactly once", async () => {
  expect(() => localUnitTestCommands([], "linux")).toThrow("zero test files");
  expect(() => localUnitTestCommands([], "win32")).toThrow("zero test files");
  const files = await collectShardedTestFiles();
  const commands = localUnitTestCommands(files, "win32");
  expect(commands.length).toBeGreaterThan(1);
  expect(commands.flatMap((command) => command.slice(4))).toEqual(files.map((path) => `./${path}`));
  for (const command of commands) {
    expect(command.length).toBeGreaterThan(4);
    expect(command.reduce((size, arg) => size + arg.length * 2 + 3, 1)).toBeLessThanOrEqual(16_000);
  }
  expect(localUnitTestCommands(files, "linux")).toEqual([localUnitTestCommand(files)]);
  let calls = 0;
  const code = await runLocalUnitTests(files, async () => (calls++ === 0 ? 7 : 0), "win32");
  expect(calls).toBe(commands.length);
  expect(code).toBe(7);
  expect(() => localUnitTestCommands(["x".repeat(16_000)], "win32")).toThrow("Windows command budget");
});

test("local, shard and timings commands select exact files rather than matching path suffixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "test-exact-selection-"));
  const file = "core/test/unit.test.ts";
  try {
    for (const [path, name] of [
      [file, "intended unit"],
      ["docs/test/core/test/unit.test.ts", "excluded docs"],
    ] as const) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `import { test } from "bun:test"; test("${name}", () => {});`);
    }
    for (const command of [
      localUnitTestCommand([file]),
      shardedUnitTestCommand("1/1", {}, [file]),
      timingRefreshCommand([file]),
    ]) {
      const child = Bun.spawn([...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = Bun.stripANSI(`${stdout}\n${stderr}`);
      expect(code, output).toBe(0);
      expect(output).toMatch(/^\s*1 pass\s*$/mu);
      expect(output).toContain("intended unit");
      expect(output).not.toContain("excluded docs");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
