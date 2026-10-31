#!/usr/bin/env bun
/**
 * Deterministic unit-test sharding for CI.
 *
 * Default (no args): print the shard commands CI should run, one per line.
 * `--run <i>/<n>`: execute shard `i` of `n` via `bun --no-orphans test --shard`.
 * Do not pass `--update-timings` with `--run`: a single shard would overwrite
 * the committed full timings file. Refresh with `update-test-timings.ts`.
 *
 * The ownership inventory supplies the same unit file set to local and CI runs.
 *
 * Balance comes from `bun test --shard --timings=.bun-test-timings.json`.
 */
import { resolve } from "node:path";
import { collectTestInventory, testOwnership } from "./test-ownership.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const UNIT_SHARD_COUNT = 3;
export const TEST_TIMINGS_FILE = ".bun-test-timings.json";

export const unitShardCommands = (): ReadonlyArray<string> =>
  Array.from(
    { length: UNIT_SHARD_COUNT },
    (_, index) => `bun run test:unit:shard ${index + 1}/${UNIT_SHARD_COUNT}`,
  );

export { FAKE_CLIENT_PROVIDER_TESTS, NIGHTLY_TIER_TESTS } from "./test-ownership.ts";

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
// CI matrix runners can spend more than Bun's default 5s in a subprocess-based test.
const SHARD_RUNTIME_FLAGS: ReadonlyArray<string> = ["--timeout=20000"];

export const isShardedUnitTest = (path: string): boolean => testOwnership(path)?.owner === "unit";

export const collectShardedTestFiles = async (root: string = REPO_ROOT): Promise<ReadonlyArray<string>> =>
  (await collectTestInventory(root)).filter((entry) => entry.owner === "unit").map((entry) => entry.path);

export const testFileArguments = (files: readonly string[]): readonly string[] =>
  files.map((path) => `./${path}`);

export const localUnitTestCommand = (files: readonly string[]): readonly string[] => [
  process.execPath,
  "--no-orphans",
  "test",
  ...SHARD_RUNTIME_FLAGS,
  ...testFileArguments(files),
];

// CreateProcessW accepts at most 32,767 UTF-16 code units. Reserve room
// for quoting and the executable; the current unit file set already exceeds it.
export const localUnitTestCommands = (
  files: readonly string[],
  platform: string = process.platform,
): readonly (readonly string[])[] => {
  if (files.length === 0) throw new Error("local unit selection resolved to zero test files");
  if (platform !== "win32") return [localUnitTestCommand(files)];
  const commands: (readonly string[])[] = [];
  let batch: string[] = [];
  const cost = (args: readonly string[]): number => args.reduce((size, arg) => size + arg.length * 2 + 3, 1);
  const limit = 16_000;
  for (const file of files) {
    if (cost(localUnitTestCommand([...batch, file])) > limit) {
      if (batch.length === 0) throw new Error(`test path exceeds Windows command budget: ${file}`);
      commands.push(localUnitTestCommand(batch));
      batch = [];
      if (cost(localUnitTestCommand([file])) > limit)
        throw new Error(`test path exceeds Windows command budget: ${file}`);
    }
    batch.push(file);
  }
  if (batch.length > 0) commands.push(localUnitTestCommand(batch));
  return commands;
};

export const runLocalUnitTests = async (
  files: readonly string[],
  run: (command: readonly string[]) => Promise<number>,
  platform: string = process.platform,
): Promise<number> => {
  let result = 0;
  for (const command of localUnitTestCommands(files, platform)) {
    const code = await run(command);
    if (result === 0) result = code;
  }
  return result;
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
  files: readonly string[] = [],
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
    ...testFileArguments(files),
  ];
};

const runShard = async (spec: string, options: { readonly updateTimings: boolean }): Promise<never> => {
  const files = await collectShardedTestFiles();
  if (files.length === 0) {
    throw new Error(`shard ${spec} resolved to zero test files`);
  }
  console.error(`[test-shards] shard ${spec}: ${files.length} collected files`);
  const proc = Bun.spawn({
    cmd: [...shardedUnitTestCommand(spec, options, files)],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args[0] === "--local" || args[0] === "--list") {
    if (args.length !== 1) throw new Error(`${args[0]} accepts no additional arguments`);
    const files = await collectShardedTestFiles();
    if (files.length === 0) throw new Error("unit selection resolved to zero test files");
    if (args[0] === "--list") {
      for (const file of files) console.log(file);
      return;
    }
    process.exitCode = await runLocalUnitTests(
      files,
      (command) =>
        Bun.spawn([...command], {
          cwd: REPO_ROOT,
          stdout: "inherit",
          stderr: "inherit",
        }).exited,
    );
    return;
  }
  if (args[0] === "--run") {
    const rest = args.slice(1);
    const updateTimings = rest.includes("--update-timings");
    const spec = rest.find((arg) => arg !== "--update-timings");
    if (spec === undefined) {
      throw new Error(`--run requires a shard spec, e.g. --run 1/${UNIT_SHARD_COUNT}`);
    }
    if (updateTimings) {
      throw new Error(
        "--update-timings on one shard would overwrite the committed full timings file; use bun run scripts/update-test-timings.ts",
      );
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
