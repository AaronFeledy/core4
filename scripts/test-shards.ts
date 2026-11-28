#!/usr/bin/env bun
/**
 * Deterministic unit-test sharding for CI.
 *
 * Default (no args): print the shard commands CI should run, one per line.
 * `--run <i>/<n>`: execute shard `i` of `n` via `bun --no-orphans test`.
 * Refresh the full timings file with `update-test-timings.ts`.
 *
 * The ownership inventory supplies the same unit file set to local and CI runs.
 */
import { resolve } from "node:path";
import { collectTestInventory, isUnitTest } from "./test-ownership.ts";
import { withRunnerOwnedTestRoots } from "./test-preload-roots.ts";
import { UNIT_SHARD_COUNT } from "./test-selections.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const TEST_TIMINGS_FILE = ".bun-test-timings.json";

export const unitShardCommands = (): ReadonlyArray<string> =>
  Array.from(
    { length: UNIT_SHARD_COUNT },
    (_, index) => `bun run test:unit:shard ${index + 1}/${UNIT_SHARD_COUNT}`,
  );

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
export const SHARD_RUNTIME_FLAGS: ReadonlyArray<string> = ["--timeout=20000"];

export const isShardedUnitTest = isUnitTest;

export const collectShardedTestFiles = async (root: string = REPO_ROOT): Promise<ReadonlyArray<string>> =>
  (await collectTestInventory({ root }))
    .filter((entry) => entry.owners.includes("unit"))
    .map((entry) => entry.path);

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
      if (cost(localUnitTestCommand([file])) > limit)
        throw new Error(`test path exceeds Windows command budget: ${file}`);
      commands.push(localUnitTestCommand(batch));
      batch = [];
    }
    batch.push(file);
  }
  commands.push(localUnitTestCommand(batch));
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

/** Each command gets its own runner-owned roots, removed once its child exits. */
export const runUnitTestCommand = (command: readonly string[], cwd: string = REPO_ROOT): Promise<number> =>
  withRunnerOwnedTestRoots(
    { env: process.env, live: false },
    (env) => Bun.spawn([...command], { cwd, env, stdout: "inherit", stderr: "inherit" }).exited,
  );

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

const readTimings = async (): Promise<ReadonlyMap<string, number>> => {
  const document: unknown = await Bun.file(resolve(REPO_ROOT, TEST_TIMINGS_FILE)).json();
  if (
    typeof document !== "object" ||
    document === null ||
    !("version" in document) ||
    document.version !== 1 ||
    !("files" in document) ||
    typeof document.files !== "object" ||
    document.files === null ||
    Array.isArray(document.files)
  ) {
    throw new TypeError(`invalid timings document: ${TEST_TIMINGS_FILE}`);
  }
  const timings = new Map<string, number>();
  for (const [file, ms] of Object.entries(document.files)) {
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) {
      throw new TypeError(`invalid timing for ${file} in ${TEST_TIMINGS_FILE}`);
    }
    timings.set(file, ms);
  }
  return timings;
};

export const selectUnitShard = (
  files: readonly string[],
  spec: string,
  timings: ReadonlyMap<string, number>,
): readonly string[] => {
  const { index, count } = parseShardSpec(spec);
  if (!Number.isSafeInteger(count) || count > files.length) {
    throw new RangeError(`cannot split ${files.length} files into ${count} nonempty shards`);
  }
  const known = files
    .flatMap((file) => {
      const ms = timings.get(file);
      return ms === undefined ? [] : [ms];
    })
    .sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const weight = (file: string): number => Math.max(1, timings.get(file) ?? median);

  // Bun packs contiguous path ranges. Assign the largest files first so one
  // large file doesn't inherit every smaller file that sorts before it.
  const shards: { readonly files: string[]; load: number }[] = Array.from({ length: count }, () => ({
    files: [],
    load: 0,
  }));
  for (const file of files.toSorted().sort((a, b) => weight(b) - weight(a))) {
    const shard = shards.reduce((lightest, candidate) =>
      candidate.load < lightest.load ? candidate : lightest,
    );
    shard.files.push(file);
    shard.load += weight(file);
  }
  const selected = shards[index - 1];
  if (selected === undefined) throw new RangeError(`shard index ${index} is not in the plan`);
  return selected.files.sort();
};

const runShard = async (spec: string): Promise<void> => {
  const files = await collectShardedTestFiles();
  const selected = selectUnitShard(files, spec, await readTimings());
  console.error(`[test-shards] shard ${spec}: ${selected.length}/${files.length} files`);
  process.exitCode = await runLocalUnitTests(selected, runUnitTestCommand);
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
    process.exitCode = await runLocalUnitTests(files, runUnitTestCommand);
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
      throw new Error("to refresh the full timings file, use bun run scripts/update-test-timings.ts");
    }
    const unknown = rest.filter((arg) => arg !== spec && arg !== "--update-timings");
    if (unknown.length > 0) {
      throw new Error(`unknown arguments: ${unknown.join(" ")}`);
    }
    await runShard(spec);
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
