#!/usr/bin/env bun
/**
 * Deterministic unit-test sharding for CI.
 *
 * Default (no args): print the shard commands CI should run, one per line.
 * `--run <i>/<n>`: execute shard `i` of `n` via `bun --no-orphans test`.
 *
 * Shards cover the same file set as `bun run test:unit` EXCEPT:
 * - files owned by dedicated CI jobs (`library-api-tests`, `recipe-tests`),
 *   which would otherwise run twice per PR, and
 * - NIGHTLY_TIER_TESTS, heavy meta-suites that re-run generators or other
 *   test files; nightly.yml runs them (see build-nightly-workflow.ts).
 */
import { resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const UNIT_SHARD_COUNT = 3;

export const unitShardCommands = (): ReadonlyArray<string> =>
  Array.from(
    { length: UNIT_SHARD_COUNT },
    (_, index) => `bun run test:unit:shard ${index + 1}/${UNIT_SHARD_COUNT}`,
  );

const INCLUDE_GLOBS: ReadonlyArray<string> = [
  "core/test/**/*.test.ts",
  "sdk/test/**/*.test.ts",
  "plugins/*/test/**/*.test.ts",
];

const INTEGRATION_SUFFIX = ".integration.test.ts";

const COVERED_BY_DEDICATED_CI_JOBS: ReadonlyArray<string> = [
  "core/test/library/",
  "sdk/test/library/",
  "core/test/recipes/",
  "core/test/cli/init.canonical-recipes.test.ts",
];

export const NIGHTLY_TIER_TESTS: ReadonlyArray<string> = [
  "core/test/scripts/codegen-ci.test.ts",
  "core/test/build/linux-acceptance-criteria-10-14.test.ts",
];

/**
 * Measured single-file wall-clock seconds (linux-x64, 2026-07) for files that
 * dominate the suite; everything else defaults to 1. Only relative magnitude
 * matters for bin-packing, so stale entries degrade balance, not correctness.
 */
const WEIGHT_HINTS: Readonly<Record<string, number>> = {
  "core/test/cli/setup.test.ts": 111,
  "core/test/cli/parity/dispatch-parity.test.ts": 108,
  "core/test/scripts/dev-guides.test.ts": 38,
  "core/test/scripts/codegen.test.ts": 20,
  "core/test/build/compile.test.ts": 15,
  "core/test/cli/shellenv.test.ts": 14,
  "core/test/cli/scratch-namespace.test.ts": 14,
  "core/test/cli/renderer-flag.scenario.test.ts": 14,
  "core/test/cli/version.test.ts": 11,
  "core/test/cli/start.scenario.test.ts": 11,
  "core/test/scripts/install-windows.test.ts": 10,
  "core/test/cli/recipes-commands.test.ts": 9,
  "core/test/cli/bug-report.scenario.test.ts": 8,
  "core/test/cli/init.recipe-selection.test.ts": 8,
  "core/test/cli/aliases.test.ts": 8,
  "core/test/build/opentui-compiled-acceptance.test.ts": 8,
  "core/test/cli/destroy.scenario.test.ts": 7,
  "core/test/cli/deferred-commands.test.ts": 7,
  "core/test/cli/app-config.scenario.test.ts": 7,
  "core/test/cli/shell.scenario.test.ts": 6,
  "core/test/scripts/docs-scenario.test.ts": 6,
  "core/test/cli/app-config-lint.scenario.test.ts": 6,
  "core/test/cli/dispatch-unification-spike.test.ts": 5,
  "core/test/cli/tooling-router.scenario.test.ts": 5,
  "core/test/build/version-embed.test.ts": 5,
  "core/test/scripts/release.test.ts": 5,
  "core/test/build/linux-acceptance-criteria-1-9.test.ts": 4,
  "core/test/build/schema-snapshot.test.ts": 4,
  "core/test/cli/redaction-ac6.test.ts": 4,
};

const isShardedUnitTest = (path: string): boolean =>
  !path.endsWith(INTEGRATION_SUFFIX) &&
  !NIGHTLY_TIER_TESTS.includes(path) &&
  !COVERED_BY_DEDICATED_CI_JOBS.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
  );

export const collectShardedTestFiles = async (): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  for (const pattern of INCLUDE_GLOBS) {
    for await (const match of new Glob(pattern).scan({ cwd: REPO_ROOT })) {
      const path = match.replaceAll("\\", "/");
      if (isShardedUnitTest(path)) {
        files.push(path);
      }
    }
  }
  return files.sort();
};

/** Greedy longest-processing-time bin packing: heaviest file to lightest shard. */
export const shardFiles = (
  files: ReadonlyArray<string>,
  shardCount: number,
): ReadonlyArray<ReadonlyArray<string>> => {
  const bins = Array.from({ length: shardCount }, () => ({
    weight: 0,
    files: [] as string[],
  }));
  const byWeightDesc = [...files].sort((a, b) => {
    const delta = (WEIGHT_HINTS[b] ?? 1) - (WEIGHT_HINTS[a] ?? 1);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  for (const file of byWeightDesc) {
    const lightest = bins.reduce((min, bin) => (bin.weight < min.weight ? bin : min));
    lightest.weight += WEIGHT_HINTS[file] ?? 1;
    lightest.files.push(file);
  }
  return bins.map((bin) => [...bin.files].sort());
};

const parseShardSpec = (spec: string): { readonly index: number; readonly count: number } => {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec);
  if (match === null) {
    throw new Error(`invalid shard spec "${spec}"; expected <i>/<n>, e.g. 2/${UNIT_SHARD_COUNT}`);
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) {
    throw new Error(`shard index ${index} exceeds shard count ${count}`);
  }
  return { index, count };
};

const runShard = async (spec: string): Promise<never> => {
  const { index, count } = parseShardSpec(spec);
  const files = shardFiles(await collectShardedTestFiles(), count)[index - 1] ?? [];
  if (files.length === 0) {
    throw new Error(`shard ${spec} resolved to zero test files`);
  }
  console.error(`[test-shards] shard ${spec}: ${files.length} files`);
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-orphans", "test", ...files],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args[0] === "--run") {
    if (args[1] === undefined) {
      throw new Error(`--run requires a shard spec, e.g. --run 1/${UNIT_SHARD_COUNT}`);
    }
    await runShard(args[1]);
    return;
  }
  if (args.length > 0) {
    throw new Error(`unknown arguments: ${args.join(" ")}`);
  }
  for (const command of unitShardCommands()) {
    console.log(command);
  }
};

if (import.meta.main) {
  await main();
}
