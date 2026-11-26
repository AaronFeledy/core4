#!/usr/bin/env bun
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { type TrackTestChild, runWithLiveTestRoots } from "../live-test-roots.ts";
import { allocateIsolatedTestRoots, releaseIsolatedTestRoots } from "../test-preload-roots.ts";
import { rewriteScenarioSourceMappedOutput } from "./scenario-source-mapper.ts";

export const LIVE_OUTPUT_ENV = "LANDO_GUIDE_SCENARIO_LIVE_OUTPUT";
export const LIVE_OUTPUT_BANNER =
  "==> guide scenarios: live unmapped bun test output follows (LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1); the source-mapped document is printed again after the child exits";
export const MAPPED_OUTPUT_BANNER =
  "==> guide scenarios: source-mapped document (authoritative; repeats the live output above)";

export const liveOutputEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[LIVE_OUTPUT_ENV] === "1";

export const SMOKE_E2E_FLAG = "--smoke-e2e";
const SMOKE_E2E_TEST_NAME_PATTERN = "--test-name-pattern=@smoke.*\\[e2e\\]";
const GENERATED_GUIDES = "test/scenarios/generated/guides";

// scripts/guides/test-render.ts writes these header lines at the top of every generated scenario.
export const isSmokeE2eScenario = (header: string): boolean =>
  /^\/\/ @layer: e2e$/m.test(header) && /^\/\/ @tags: (?:.*,)?@smoke(?:,.*)?$/m.test(header);

// `--smoke-e2e` names the generated @smoke [e2e] files explicitly, so `bun test --shard=<i>/<n>`
// splits exactly those files instead of every generated guide file.
export const expandSmokeE2e = async (
  args: ReadonlyArray<string>,
  root: string,
): Promise<ReadonlyArray<string>> => {
  if (!args.includes(SMOKE_E2E_FLAG)) return args;
  const files: string[] = [];
  for await (const path of new Bun.Glob(`${GENERATED_GUIDES}/**/*.test.ts`).scan({ cwd: root })) {
    if (isSmokeE2eScenario(await Bun.file(join(root, path)).slice(0, 2048).text())) files.push(`./${path}`);
  }
  if (files.length === 0) {
    throw new Error(
      `${SMOKE_E2E_FLAG} found no @smoke [e2e] scenarios under ${GENERATED_GUIDES}; run \`bun run codegen\` first`,
    );
  }
  // Bun passes a shard that receives no files, so a shard count above the file count would hide a skipped leg.
  const shardCount = Number(
    /^--shard=\d+\/(\d+)$/.exec(args.find((arg) => arg.startsWith("--shard=")) ?? "")?.[1] ?? 1,
  );
  if (files.length < shardCount) {
    throw new Error(
      `${SMOKE_E2E_FLAG} found ${files.length} @smoke [e2e] scenarios for ${shardCount} shards; lower the shard count`,
    );
  }
  return [...files.sort(), SMOKE_E2E_TEST_NAME_PATTERN, ...args.filter((arg) => arg !== SMOKE_E2E_FLAG)];
};

// Response.text() owns the buffered read: a hand-rolled getReader() loop over a
// subprocess stream intermittently drops trailing bytes. Live callers get their
// own tee() branch so teeing never touches the authoritative buffer.
export const drainStream = async (
  stream: ReadableStream<Uint8Array>,
  tee: ((chunk: Uint8Array) => void) | null,
): Promise<string> => {
  if (tee === null) return new Response(stream).text();
  const [live, buffered] = stream.tee();
  const pump = (async (): Promise<void> => {
    const reader = live.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      tee(value);
    }
  })();
  const [text] = await Promise.all([new Response(buffered).text(), pump]);
  return text;
};

const isE2eRun = (args: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>): boolean =>
  env.LANDO_GUIDE_E2E === "1" ||
  args.some((arg, index) => {
    let pattern: string | undefined;
    if (arg.startsWith("--test-name-pattern=")) {
      pattern = arg.slice("--test-name-pattern=".length);
    } else if (arg === "--test-name-pattern" || arg === "-t") {
      pattern = args[index + 1];
    }
    return pattern?.replaceAll("\\", "").includes("[e2e]") === true;
  });

export const guideScenarioTestArgs = (
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cpus = availableParallelism(),
): ReadonlyArray<string> => {
  const serialArgs = args.some((arg) => arg === "--max-concurrency" || arg.startsWith("--max-concurrency="))
    ? args
    : [...args, "--max-concurrency=1"];
  if (isE2eRun(args, env)) return [...serialArgs, "--parallel=1", "--max-concurrency=1"];
  return args.some((arg) => arg === "--parallel" || arg.startsWith("--parallel="))
    ? serialArgs
    : [...serialArgs, `--parallel=${Math.max(1, Math.min(8, cpus))}`];
};

const runTests = async (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  track: TrackTestChild,
): Promise<number> => {
  const live = liveOutputEnabled(env);
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", ...guideScenarioTestArgs(args, env)],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  track(proc);

  try {
    if (live) process.stdout.write(`${LIVE_OUTPUT_BANNER}\n`);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      drainStream(
        proc.stdout,
        live
          ? (chunk) => {
              process.stdout.write(chunk);
            }
          : null,
      ),
      drainStream(
        proc.stderr,
        live
          ? (chunk) => {
              process.stderr.write(chunk);
            }
          : null,
      ),
    ]);

    if (live) process.stdout.write(`${MAPPED_OUTPUT_BANNER}\n`);
    process.stdout.write(rewriteScenarioSourceMappedOutput(`${stdout}${stderr}`));
    return exitCode;
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }
};

const main = async (): Promise<never> => {
  const cwd = process.cwd();
  const env: Record<string, string | undefined> = { ...process.env };
  const args = await expandSmokeE2e(Bun.argv.slice(2), cwd);
  const live = env.LANDO_GUIDE_E2E === "1";
  const fallbackDirectory = live ? undefined : allocateIsolatedTestRoots(env);
  let exitCode = 1;
  try {
    exitCode = await runWithLiveTestRoots({ live, cwd, env }, (childEnv, track) =>
      runTests(args, childEnv, track),
    );
  } finally {
    releaseIsolatedTestRoots(fallbackDirectory);
  }
  // Bun's empty-write callback can precede flushing; end both streams before exiting.
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.end(resolve))),
  );
  process.exit(exitCode);
};

if (import.meta.main) await main();
