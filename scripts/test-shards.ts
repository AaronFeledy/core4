#!/usr/bin/env bun
/**
 * Deterministic unit-test sharding for CI.
 *
 * Default (no args): print the shard commands CI should run, one per line.
 * `--run <i>/<n>`: execute shard `i` of `n` via `bun --no-orphans test --shard`.
 * `--update-timings` (with `--run`): rewrite this shard's entries in the
 * committed timings file after the run.
 *
 * Native `bun test --shard` does not know this repo's exclusions, so this
 * script still collects the file set. Shards cover the same files as
 * `bun run test:unit` EXCEPT:
 * - files owned by dedicated CI jobs (`library-api-tests`, `recipe-tests`),
 *   which would otherwise run twice per PR, and
 * - NIGHTLY_TIER_TESTS, heavy meta-suites that re-run generators or other
 *   test files; nightly.yml runs them (see build-nightly-workflow.ts).
 *
 * Balance comes from `bun test --shard --timings=.bun-test-timings.json`.
 */
import { resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const UNIT_SHARD_COUNT = 3;
export const TEST_TIMINGS_FILE = ".bun-test-timings.json";

export const unitShardCommands = (): ReadonlyArray<string> =>
  Array.from(
    { length: UNIT_SHARD_COUNT },
    (_, index) => `bun run test:unit:shard ${index + 1}/${UNIT_SHARD_COUNT}`,
  );

const INCLUDE_GLOBS: ReadonlyArray<string> = [
  "core/test/**/*.test.ts",
  "data-mover/test/**/*.test.ts",
  "telemetry/test/**/*.test.ts",
  "renderer/test/**/*.test.ts",
  "mcp/test/**/*.test.ts",
  "engine/test/**/*.test.ts",
  "container-runtime/test/**/*.test.ts",
  "http-client/test/**/*.test.ts",
  "landofile/test/**/*.test.ts",
  "managed-file/test/**/*.test.ts",
  "paths/test/**/*.test.ts",
  "state-store/test/**/*.test.ts",
  "redaction/test/**/*.test.ts",
  "sdk/test/**/*.test.ts",
  "plugins/*/test/**/*.test.ts",
  "docs/test/**/*.test.ts",
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
 * `--parallel` implies `--isolate` unless `--no-isolate`. This suite shares
 * bunfig.toml preload and Effect layers. Bun 1.4 `--parallel --no-isolate`
 * was tried on shard 1/3 (2026-08-21) and rejected: compiled-binary tests
 * flake when workers share the same outfile. Attempt 1 failed
 * `bug-report` compiled $bunfs smoke and the compiled Linux x64 version/help
 * fast path. Attempt 2 failed compiled app-command aliases and
 * `apps:list --path` on the compiled binary. Serial shard 1 passed
 * (2828 pass / 0 fail).
 */
const SHARD_RUNTIME_FLAGS: ReadonlyArray<string> = [];

export const isShardedUnitTest = (path: string): boolean =>
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

export const shardedUnitTestCommand = (
  spec: string,
  options: { readonly updateTimings?: boolean } = {},
): ReadonlyArray<string> => {
  const { index, count } = parseShardSpec(spec);
  return [
    process.execPath,
    "--no-orphans",
    "test",
    ...SHARD_RUNTIME_FLAGS,
    `--shard=${index}/${count}`,
    `--timings=${TEST_TIMINGS_FILE}`,
    ...(options.updateTimings === true ? ["--update-timings"] : []),
  ];
};

const runShard = async (spec: string, options: { readonly updateTimings: boolean }): Promise<never> => {
  const files = await collectShardedTestFiles();
  if (files.length === 0) {
    throw new Error(`shard ${spec} resolved to zero test files`);
  }
  console.error(`[test-shards] shard ${spec}: ${files.length} collected files`);
  const proc = Bun.spawn({
    cmd: [...shardedUnitTestCommand(spec, options), ...files],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args[0] === "--run") {
    const rest = args.slice(1);
    const updateTimings = rest.includes("--update-timings");
    const spec = rest.find((arg) => arg !== "--update-timings");
    if (spec === undefined) {
      throw new Error(`--run requires a shard spec, e.g. --run 1/${UNIT_SHARD_COUNT}`);
    }
    const unknown = rest.filter((arg) => arg !== spec && arg !== "--update-timings");
    if (unknown.length > 0) {
      throw new Error(`unknown arguments: ${unknown.join(" ")}`);
    }
    await runShard(spec, { updateTimings });
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
