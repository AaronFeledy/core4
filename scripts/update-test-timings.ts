#!/usr/bin/env bun
/**
 * Refresh committed `.bun-test-timings.json` from the collected shard file set.
 *
 * Native `bun test --shard` balances from this file.
 * The ownership inventory supplies the same unit file set to local and CI runs.
 */
import { resolve } from "node:path";

import { TEST_TIMINGS_FILE, collectShardedTestFiles, testFileArguments } from "./test-shards.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const timingRefreshCommand = (
  files: readonly string[],
  timingsFile: string = TEST_TIMINGS_FILE,
): readonly string[] => [
  process.execPath,
  "--no-orphans",
  "test",
  `--timings=${timingsFile}`,
  "--update-timings",
  ...testFileArguments(files),
];

const main = async (): Promise<never> => {
  const files = await collectShardedTestFiles();
  if (files.length === 0) {
    throw new Error("update-test-timings resolved to zero test files");
  }
  console.error(`[update-test-timings] measuring ${files.length} files -> ${TEST_TIMINGS_FILE}`);
  const proc = Bun.spawn({
    cmd: [...timingRefreshCommand(files)],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
};

if (import.meta.main) {
  await main();
}
