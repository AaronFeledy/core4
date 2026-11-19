#!/usr/bin/env bun
/**
 * Redaction hot-path benchmark.
 *
 * Measures the redaction primitives Lando runs on every log, result, and frame:
 * complete-text redaction, the bounded line-stream, the live channel, command
 * result envelope encoding, and the MCP bounded-JSON path. The corpus is built
 * in-process and deterministically, so the same file produces the same bytes in
 * every checkout.
 *
 * `--repo <path>` imports each module from that checkout by absolute path, so
 * this script runs unchanged against `origin/main` and reports the same case
 * names. A case whose module or export does not exist there is reported as
 * `skipped: API absent` and never compared, which is how the live channel (new
 * on this branch) stays out of the main baseline.
 */
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { loadApi } from "./bench-redaction-api.ts";
import { caseDefinitions } from "./bench-redaction-cases.ts";
import { buildCorpus, buildTexts } from "./bench-redaction-corpus.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const TimingBaseline = Schema.Struct({
  medianMs: Schema.Number.check(Schema.isGreaterThan(0)),
  p95Ms: Schema.Number.check(Schema.isGreaterThan(0)),
});

const BaselineFile = Schema.Struct({
  redaction: Schema.Struct({
    baseCommit: Schema.String,
    platform: Schema.String,
    runs: Schema.Int.check(Schema.isGreaterThan(0)),
    warmups: Schema.Literal(3),
    allowedRegressionPercent: Schema.Number.check(Schema.isGreaterThan(0)),
    /** Cases with no origin/main comparator; their first branch run is the baseline. */
    initialCases: Schema.optionalKey(Schema.Array(Schema.String)),
    cases: Schema.Record(Schema.String, TimingBaseline),
  }),
});

type Baseline = (typeof BaselineFile)["Type"]["redaction"];

export const readBaseline = async (path: string): Promise<Baseline> =>
  Schema.decodeUnknownSync(BaselineFile)(await Bun.file(path).json()).redaction;

export interface BenchOptions {
  readonly repo: string;
  readonly baselinePath: string;
  readonly runs: number;
  readonly caseName: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
}

export const parseArgs = (argv: readonly string[]): BenchOptions => {
  let repo = repoRoot;
  let baselinePath = join(repoRoot, "scripts/bench-baselines.json");
  let runs = 60;
  let caseName: string | undefined;
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = (argv[index] ?? "").split("=", 2);
    const value = (): string => {
      const next = inline ?? argv[++index];
      if (next === undefined) throw new TypeError(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--json":
        json = true;
        break;
      case "--runs":
        runs = Number(value());
        if (!Number.isSafeInteger(runs) || runs < 1) throw new TypeError("--runs must be a positive integer");
        break;
      case "--repo":
        repo = resolve(value());
        break;
      case "--baseline":
        baselinePath = resolve(value());
        break;
      case "--case":
        caseName = value();
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new TypeError(`Unknown option ${flag}`);
    }
  }
  return { repo, baselinePath, runs, caseName, json, help };
};

// ==== timing ====

const percentile = (sorted: readonly number[], fraction: number): number => {
  const value = sorted[Math.ceil(sorted.length * fraction) - 1];
  if (value === undefined) throw new RangeError("Cannot summarize empty timings");
  return value;
};

const median = (sorted: readonly number[]): number => {
  const middle = sorted.slice(Math.floor((sorted.length - 1) / 2), Math.floor(sorted.length / 2) + 1);
  return middle.reduce((sum, value) => sum + value, 0) / middle.length;
};

interface Measurement {
  readonly medianMs: number;
  readonly p95Ms: number;
}

const measure = (run: () => void, warmups: number, runs: number): Measurement => {
  for (let index = 0; index < warmups; index += 1) run();
  const timings: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    run();
    timings.push(performance.now() - start);
  }
  timings.sort((left, right) => left - right);
  return { medianMs: median(timings), p95Ms: percentile(timings, 0.95) };
};

export interface CaseResult {
  readonly case: string;
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly reason?: string;
  readonly measurement?: Measurement;
  readonly baseline?: Measurement;
  readonly medianDeltaPercent?: number;
  readonly p95DeltaPercent?: number;
}

export interface BenchResult {
  readonly ok: boolean;
  readonly repo: string;
  readonly platform: string;
  readonly runs: number;
  readonly warmups: number;
  readonly allowedRegressionPercent: number;
  readonly baseCommit: string;
  readonly cases: readonly CaseResult[];
}

const deltaPercent = (measured: number, baseline: number): number => ((measured - baseline) / baseline) * 100;

export const runBenchmark = async (options: BenchOptions): Promise<BenchResult> => {
  const baseline = await readBaseline(options.baselinePath);
  const corpus = buildCorpus();
  const texts = buildTexts();
  const api = await loadApi(options.repo);
  const multiplier = 1 + baseline.allowedRegressionPercent / 100;
  const selected = caseDefinitions.filter(
    (definition) => options.caseName === undefined || definition.name === options.caseName,
  );
  if (options.caseName !== undefined && selected.length === 0) {
    throw new TypeError(`Unknown case ${options.caseName}`);
  }

  const cases: CaseResult[] = [];
  for (const definition of selected) {
    const run = definition.make(api, corpus, texts);
    if (run === undefined) {
      cases.push({ case: definition.name, ok: true, skipped: true, reason: "skipped: API absent" });
      continue;
    }
    const measurement = measure(run, baseline.warmups, options.runs);
    const prior = baseline.cases[definition.name];
    if (prior === undefined) {
      cases.push({ case: definition.name, ok: true, skipped: false, measurement });
      continue;
    }
    const ok =
      measurement.medianMs <= prior.medianMs * multiplier && measurement.p95Ms <= prior.p95Ms * multiplier;
    cases.push({
      case: definition.name,
      ok,
      skipped: false,
      measurement,
      baseline: prior,
      medianDeltaPercent: deltaPercent(measurement.medianMs, prior.medianMs),
      p95DeltaPercent: deltaPercent(measurement.p95Ms, prior.p95Ms),
    });
  }

  return {
    ok: cases.every((entry) => entry.ok),
    repo: options.repo,
    platform: `${process.platform}-${process.arch}`,
    runs: options.runs,
    warmups: baseline.warmups,
    allowedRegressionPercent: baseline.allowedRegressionPercent,
    baseCommit: baseline.baseCommit,
    cases,
  };
};

const formatDelta = (delta: number | undefined): string => {
  if (delta === undefined) return "   n/a";
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
};

const formatMs = (value: number): string => value.toFixed(3);

const printHuman = (result: BenchResult): void => {
  console.log(
    `Redaction benchmark ${result.ok ? "passed" : "failed"} (+${result.allowedRegressionPercent}% median/p95 cap)`,
  );
  console.log(`repo: ${result.repo}`);
  console.log(`runs: ${result.runs}, warmups: ${result.warmups}, baseline commit: ${result.baseCommit}`);
  for (const entry of result.cases) {
    if (entry.skipped) {
      console.log(`${entry.case}: ${entry.reason ?? "skipped"}`);
      continue;
    }
    const measurement = entry.measurement;
    if (measurement === undefined) continue;
    const baselineText =
      entry.baseline === undefined
        ? "no baseline"
        : `base median ${formatMs(entry.baseline.medianMs)}ms, p95 ${formatMs(entry.baseline.p95Ms)}ms`;
    console.log(
      `${entry.case}: median ${formatMs(measurement.medianMs)}ms, p95 ${formatMs(measurement.p95Ms)}ms (${formatDelta(entry.medianDeltaPercent)} / ${formatDelta(entry.p95DeltaPercent)}; ${baselineText}) ${entry.ok ? "ok" : "REGRESSION"}`,
    );
  }
};

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: bun run scripts/bench-redaction.ts [--json] [--runs=N] [--repo <path>] [--case <name>] [--baseline <path>]",
    );
  } else {
    const result = await runBenchmark(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  }
}
