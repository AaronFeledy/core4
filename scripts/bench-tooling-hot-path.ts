#!/usr/bin/env bun
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BASELINE = resolve(REPO_ROOT, "scripts/bench-baselines.json");
const DEFAULT_BINARY = resolve(REPO_ROOT, "core/dist/lando");
const DEFAULT_CWD = resolve(REPO_ROOT, "scripts/fixtures/tooling-hot-path");

interface Baseline {
  readonly description: string;
  readonly platform: string;
  readonly command: ReadonlyArray<string>;
  readonly targetWarmP95Ms: number;
  readonly baselineWarmP95Ms: number;
  readonly allowedRegressionPercent: number;
  readonly coldRuns: number;
  readonly warmRuns: number;
}

interface Options {
  readonly binary: string;
  readonly baselinePath: string;
  readonly command?: ReadonlyArray<string>;
  readonly runs?: number;
  readonly coldRuns?: number;
  readonly cwd: string;
  readonly json: boolean;
}

interface TimingSummary {
  readonly coldMs: ReadonlyArray<number>;
  readonly warmMs: ReadonlyArray<number>;
  readonly coldP95Ms: number;
  readonly warmP95Ms: number;
  readonly maxAllowedWarmP95Ms: number;
  readonly targetWarmP95Ms: number;
  readonly baselineWarmP95Ms: number;
  readonly allowedRegressionPercent: number;
  readonly command: ReadonlyArray<string>;
}

const usage = `Usage: bun run scripts/bench-tooling-hot-path.ts [options]

Options:
  --binary <path>       Lando binary to benchmark (default: core/dist/lando)
  --baseline <path>     Baseline JSON path (default: scripts/bench-baselines.json)
  --command <cmd...>    Command to pass to the binary (default: baseline command)
  --runs <n>            Warm runs to measure (default: baseline warmRuns)
  --cold-runs <n>       Cold runs to measure (default: baseline coldRuns)
  --cwd <path>          Working directory for invocations (default: repo root)
  --json                Emit JSON summary
`;

const parsePositiveInteger = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return parsed;
};

export const parseArgs = (argv: ReadonlyArray<string>): Options => {
  let binary = DEFAULT_BINARY;
  let baselinePath = DEFAULT_BASELINE;
  let command: ReadonlyArray<string> | undefined;
  let runs: number | undefined;
  let coldRuns: number | undefined;
  let cwd = DEFAULT_CWD;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const readValue = (label: string): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${label} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    } else if (arg === "--binary") {
      binary = resolve(readValue(arg));
    } else if (arg === "--baseline") {
      baselinePath = resolve(readValue(arg));
    } else if (arg === "--runs") {
      runs = parsePositiveInteger(readValue(arg), arg);
    } else if (arg === "--cold-runs") {
      coldRuns = parsePositiveInteger(readValue(arg), arg);
    } else if (arg === "--cwd") {
      cwd = resolve(readValue(arg));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--command") {
      const values = argv.slice(index + 1);
      if (values.length === 0) throw new Error("--command requires at least one command argument");
      command = values;
      index = argv.length;
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }

  return {
    binary,
    baselinePath,
    ...(command === undefined ? {} : { command }),
    ...(runs === undefined ? {} : { runs }),
    ...(coldRuns === undefined ? {} : { coldRuns }),
    cwd,
    json,
  };
};

const numberField = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Baseline field ${key} must be a number`);
  return value;
};

const stringField = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Baseline field ${key} must be a string`);
  return value;
};

export const readBaseline = async (path: string): Promise<Baseline> => {
  const parsed: unknown = await Bun.file(path).json();
  if (typeof parsed !== "object" || parsed === null || !("toolingHotPath" in parsed)) {
    throw new Error("Baseline JSON must contain toolingHotPath");
  }
  const root = parsed as { readonly toolingHotPath: unknown };
  if (typeof root.toolingHotPath !== "object" || root.toolingHotPath === null) {
    throw new Error("toolingHotPath baseline must be an object");
  }
  const record = root.toolingHotPath as Record<string, unknown>;
  const command = record.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Baseline field command must be a non-empty string array");
  }

  return {
    description: stringField(record, "description"),
    platform: stringField(record, "platform"),
    command: command as ReadonlyArray<string>,
    targetWarmP95Ms: numberField(record, "targetWarmP95Ms"),
    baselineWarmP95Ms: numberField(record, "baselineWarmP95Ms"),
    allowedRegressionPercent: numberField(record, "allowedRegressionPercent"),
    coldRuns: parsePositiveInteger(String(numberField(record, "coldRuns")), "coldRuns"),
    warmRuns: parsePositiveInteger(String(numberField(record, "warmRuns")), "warmRuns"),
  };
};

const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
  if (values.length === 0) throw new Error("Cannot compute percentile of an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)));
  const value = sorted[index];
  if (value === undefined) throw new Error("Unable to compute percentile");
  return value;
};

const runOne = async (input: {
  readonly binary: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
}): Promise<number> => {
  const start = performance.now();
  const proc = Bun.spawn({
    cmd: [input.binary, ...input.command],
    cwd: input.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(`Benchmark command failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return performance.now() - start;
};

const runMany = async (
  count: number,
  input: { readonly binary: string; readonly command: ReadonlyArray<string>; readonly cwd: string },
) => {
  const timings: number[] = [];
  for (let index = 0; index < count; index += 1) {
    timings.push(await runOne(input));
  }
  return timings;
};

export const runBenchmark = async (options: Options, baseline: Baseline): Promise<TimingSummary> => {
  const command = options.command ?? baseline.command;
  const warmRuns = options.runs ?? baseline.warmRuns;
  const coldRuns = options.coldRuns ?? baseline.coldRuns;
  const input = { binary: options.binary, command, cwd: options.cwd };
  await runOne({ binary: options.binary, command: ["app:cache:refresh"], cwd: options.cwd });
  const coldMs = await runMany(coldRuns, input);
  const warmMs = await runMany(warmRuns, input);
  const maxAllowedWarmP95Ms = baseline.baselineWarmP95Ms * (1 + baseline.allowedRegressionPercent / 100);

  return {
    coldMs,
    warmMs,
    coldP95Ms: percentile(coldMs, 0.95),
    warmP95Ms: percentile(warmMs, 0.95),
    maxAllowedWarmP95Ms,
    targetWarmP95Ms: baseline.targetWarmP95Ms,
    baselineWarmP95Ms: baseline.baselineWarmP95Ms,
    allowedRegressionPercent: baseline.allowedRegressionPercent,
    command,
  };
};

const formatMs = (value: number): string =>
  `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}ms`;

const formatSummary = (summary: TimingSummary): string =>
  [
    "tooling hot path benchmark passed",
    `command: ${summary.command.join(" ")}`,
    `cold p95 ${formatMs(summary.coldP95Ms)}`,
    `warm p95 ${formatMs(summary.warmP95Ms)} (baseline ${formatMs(summary.baselineWarmP95Ms)}, regression budget ${formatMs(summary.maxAllowedWarmP95Ms)}, target ${formatMs(summary.targetWarmP95Ms)})`,
  ].join("\n");

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  const baseline = await readBaseline(options.baselinePath);
  const summary = await runBenchmark(options, baseline);

  if (summary.warmP95Ms > summary.maxAllowedWarmP95Ms) {
    const message = `tooling hot path benchmark failed: warm p95 ${formatMs(summary.warmP95Ms)} exceeded regression budget ${formatMs(summary.maxAllowedWarmP95Ms)} (baseline ${formatMs(summary.baselineWarmP95Ms)} + ${summary.allowedRegressionPercent}%)`;
    if (options.json) process.stderr.write(`${JSON.stringify({ ok: false, ...summary })}\n`);
    else process.stderr.write(`${message}\n`);
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
