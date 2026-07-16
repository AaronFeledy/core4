#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BINARY = resolve(REPO_ROOT, "core/dist/lando");
const COMMAND = ["--version"] as const;
const DEFAULT_RUNS = 20;
const STARTUP_BUDGET_MS = 50;
const FIRST_OUTPUT_BUDGET_MS = 50;

type Options = {
  readonly binary: string;
  readonly runs: number;
  readonly startupBudgetMs: number;
  readonly firstOutputBudgetMs: number;
  readonly json: boolean;
};

type RunTiming = {
  readonly startupMs: number;
  readonly firstOutputMs: number;
};

type Summary = {
  readonly platform: "linux-x64";
  readonly command: typeof COMMAND;
  readonly runs: number;
  readonly startupP95Ms: number;
  readonly firstOutputP95Ms: number;
  readonly startupBudgetMs: number;
  readonly firstOutputBudgetMs: number;
};

const usage = `Usage: bun run scripts/bench-opentui-startup.ts [options]

Options:
  --binary <path>                  Linux x64 compiled binary (default: core/dist/lando)
  --runs <n>                       Process samples (default: ${DEFAULT_RUNS})
  --startup-budget-ms <n>          End-to-end p95 budget (default: ${STARTUP_BUDGET_MS})
  --first-output-budget-ms <n>     First-output p95 budget (default: ${FIRST_OUTPUT_BUDGET_MS})
  --json                           Emit a JSON summary
`;

const positiveNumber = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive, got ${value}`);
  return parsed;
};

const positiveInteger = (value: string, label: string): number => {
  const parsed = positiveNumber(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer, got ${value}`);
  return parsed;
};

export const parseArgs = (argv: ReadonlyArray<string>): Options => {
  let binary = DEFAULT_BINARY;
  let runs = DEFAULT_RUNS;
  let startupBudgetMs = STARTUP_BUDGET_MS;
  let firstOutputBudgetMs = FIRST_OUTPUT_BUDGET_MS;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    } else if (arg === "--binary") binary = resolve(value());
    else if (arg === "--runs") runs = positiveInteger(value(), arg);
    else if (arg === "--startup-budget-ms") startupBudgetMs = positiveNumber(value(), arg);
    else if (arg === "--first-output-budget-ms") firstOutputBudgetMs = positiveNumber(value(), arg);
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown option ${arg}`);
  }

  return { binary, runs, startupBudgetMs, firstOutputBudgetMs, json };
};

const percentile95 = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) throw new Error("Cannot compute p95 without samples");
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (value === undefined) throw new Error("Unable to compute p95");
  return value;
};

const consume = async (stream: ReadableStream<Uint8Array>, onChunk: () => void): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    if (chunk.byteLength > 0) onChunk();
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const measureOne = async (input: {
  readonly binary: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<RunTiming> => {
  const start = performance.now();
  let firstOutputMs: number | undefined;
  const proc = Bun.spawn({
    cmd: [input.binary, ...COMMAND],
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const markFirstOutput = (): void => {
    firstOutputMs ??= performance.now() - start;
  };
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    consume(proc.stdout, markFirstOutput),
    consume(proc.stderr, markFirstOutput),
  ]);
  if (exitCode !== 0) throw new Error(`Startup command failed with exit code ${exitCode}: ${stderr.trim()}`);
  if (firstOutputMs === undefined) throw new Error("Startup command exited without stdout or stderr output");
  return { startupMs: performance.now() - start, firstOutputMs };
};

export const runBenchmark = async (options: Options): Promise<Summary> => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "lando-opentui-startup-"));
  try {
    const env = {
      ...process.env,
      LANDO_USER_CONF_ROOT: resolve(sandbox, "config"),
      LANDO_USER_DATA_ROOT: resolve(sandbox, "data"),
      LANDO_USER_CACHE_ROOT: resolve(sandbox, "cache"),
    };
    const timings: RunTiming[] = [];
    for (let index = 0; index < options.runs; index += 1) {
      timings.push(await measureOne({ binary: options.binary, cwd: sandbox, env }));
    }
    return {
      platform: "linux-x64",
      command: COMMAND,
      runs: options.runs,
      startupP95Ms: percentile95(timings.map((timing) => timing.startupMs)),
      firstOutputP95Ms: percentile95(timings.map((timing) => timing.firstOutputMs)),
      startupBudgetMs: options.startupBudgetMs,
      firstOutputBudgetMs: options.firstOutputBudgetMs,
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
};

const formatMs = (value: number): string =>
  `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}ms`;

const formatSummary = (summary: Summary): string =>
  [
    "OpenTUI startup benchmark passed",
    `platform: ${summary.platform}`,
    `command: ${summary.command.join(" ")}`,
    `samples: ${summary.runs}`,
    `startup p95 ${formatMs(summary.startupP95Ms)} (budget ${formatMs(summary.startupBudgetMs)})`,
    `first output p95 ${formatMs(summary.firstOutputP95Ms)} (budget ${formatMs(summary.firstOutputBudgetMs)})`,
  ].join("\n");

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  const summary = await runBenchmark(options);
  const startupPassed = summary.startupP95Ms < summary.startupBudgetMs;
  const firstOutputPassed = summary.firstOutputP95Ms < summary.firstOutputBudgetMs;
  if (!startupPassed || !firstOutputPassed) {
    if (options.json) process.stderr.write(`${JSON.stringify({ ok: false, ...summary })}\n`);
    else {
      process.stderr.write(
        `OpenTUI startup benchmark failed: startup p95 ${formatMs(summary.startupP95Ms)} (budget ${formatMs(summary.startupBudgetMs)}); first output p95 ${formatMs(summary.firstOutputP95Ms)} (budget ${formatMs(summary.firstOutputBudgetMs)})\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, ...summary })}\n`);
  else process.stdout.write(`${formatSummary(summary)}\n`);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
