#!/usr/bin/env bun
/**
 * Refresh committed `.bun-test-timings.json` from the collected shard file set.
 *
 * Native `bun test --shard` balances from this file.
 * The collector excludes integration tests except the three fake-client provider contract suites, plus suites owned by dedicated jobs and the nightly tier.
 */
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { TEST_TIMINGS_FILE, collectShardedTestFiles } from "./test-shards.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

interface RefreshOptions {
  readonly files: ReadonlyArray<string>;
  readonly repoRoot: string;
  readonly runTests: (cmd: ReadonlyArray<string>, cwd: string) => Promise<number>;
}

const runTests = async (cmd: ReadonlyArray<string>, cwd: string): Promise<number> => {
  const proc = Bun.spawn({ cmd: [...cmd], cwd, stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
};

const validateCandidate = (contents: string, files: ReadonlyArray<string>): void => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(contents);
  } catch {
    throw new Error("update-test-timings produced invalid JSON");
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("update-test-timings produced an invalid timing document");
  }
  const document = candidate as Record<string, unknown>;
  const timings = document.files;
  if (document.version !== 1 || typeof timings !== "object" || timings === null || Array.isArray(timings)) {
    throw new Error("update-test-timings produced an invalid timing document");
  }
  const entries = Object.entries(timings);
  const expected = new Set(files);
  if (
    expected.size !== files.length ||
    entries.length !== expected.size ||
    entries.some(
      ([path, duration]) =>
        !expected.has(path) ||
        typeof duration !== "number" ||
        !Number.isSafeInteger(duration) ||
        duration < 0,
    )
  ) {
    throw new Error("update-test-timings produced incomplete or invalid file timings");
  }
};

export const refreshTestTimings = async ({
  files,
  repoRoot,
  runTests: execute,
}: RefreshOptions): Promise<number> => {
  if (files.length === 0) {
    throw new Error("update-test-timings resolved to zero test files");
  }
  const candidateRoot = await mkdtemp(resolve(repoRoot, ".bun-test-timings-"));
  const candidatePath = resolve(candidateRoot, "candidate.json");
  try {
    console.error(`[update-test-timings] measuring ${files.length} files -> ${TEST_TIMINGS_FILE}`);
    const exitCode = await execute(
      [process.execPath, "--no-orphans", "test", `--timings=${candidatePath}`, "--update-timings", ...files],
      repoRoot,
    );
    if (exitCode !== 0) return exitCode;
    validateCandidate(await readFile(candidatePath, "utf8"), files);
    await rename(candidatePath, resolve(repoRoot, TEST_TIMINGS_FILE));
    return 0;
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  process.exitCode = await refreshTestTimings({
    files: await collectShardedTestFiles(),
    repoRoot: REPO_ROOT,
    runTests,
  });
}
