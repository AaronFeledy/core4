#!/usr/bin/env bun
/**
 * Refresh committed `.bun-test-timings.json` from the collected shard file set.
 *
 * Native `bun test --shard` balances from this file. The collector still
 * excludes `*.integration.test.ts`, dedicated library/recipe CI jobs, and
 * NIGHTLY_TIER_TESTS so timings match what `bun run test:unit:shard` runs.
 */
import { resolve } from "node:path";

import { TEST_TIMINGS_FILE, collectShardedTestFiles } from "./test-shards.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const main = async (): Promise<never> => {
  const files = await collectShardedTestFiles();
  if (files.length === 0) {
    throw new Error("update-test-timings resolved to zero test files");
  }
  console.error(`[update-test-timings] measuring ${files.length} files -> ${TEST_TIMINGS_FILE}`);
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-orphans",
      "test",
      `--timings=${TEST_TIMINGS_FILE}`,
      "--update-timings",
      ...files,
    ],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
};

if (import.meta.main) {
  await main();
}
