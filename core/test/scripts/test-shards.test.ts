import { describe, expect, test } from "bun:test";

import {
  NIGHTLY_TIER_TESTS,
  TEST_TIMINGS_FILE,
  UNIT_SHARD_COUNT,
  collectShardedTestFiles,
  isShardedUnitTest,
  shardedUnitTestCommand,
  unitShardCommands,
} from "../../../scripts/test-shards.ts";

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

    const files = await collectShardedTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith(".integration.test.ts"))).toBe(false);
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
      "--shard=1/3",
      `--timings=${TEST_TIMINGS_FILE}`,
    ]);
    expect(shardedUnitTestCommand("2/3", { updateTimings: true })).toEqual([
      process.execPath,
      "--no-orphans",
      "test",
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
