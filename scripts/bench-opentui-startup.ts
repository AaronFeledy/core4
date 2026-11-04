#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { arch, loadavg, platform, release, tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { type Baseline, percentile95, readBaseline } from "./bench-startup-baseline.ts";
import { readTtyOverheadBaseline, runTtyOverheadBenchmark } from "./bench-tty-renderer-overhead.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BASELINE = resolve(REPO_ROOT, "scripts/bench-baselines.json");
const DEFAULT_BINARY = resolve(REPO_ROOT, "core/dist/lando");

type Options = {
  readonly binary: string;
  readonly compareBinary?: string;
  readonly baselinePath: string;
  readonly runs?: number;
  readonly startupBudgetMs?: number;
  readonly firstOutputBudgetMs?: number;
  readonly json: boolean;
};

type RunTiming = {
  readonly startupMs: number;
  readonly firstOutputMs: number;
};
type Role = "candidate" | "reference";

type Summary = {
  readonly platform: "linux-x64";
  readonly command: ReadonlyArray<string>;
  readonly runs: number;
  readonly startupP95Ms: number;
  readonly firstOutputP95Ms: number;
  readonly startupWithinBudget: boolean;
  readonly firstOutputWithinBudget: boolean;
  readonly startupBudgetMs: number;
  readonly firstOutputBudgetMs: number;
  readonly samples: ReadonlyArray<
    RunTiming & { readonly pair: number; readonly role: Role; readonly order: number }
  >;
  readonly reference?: {
    readonly startupP95Ms: number;
    readonly firstOutputP95Ms: number;
    readonly startupWithinBudget: boolean;
    readonly firstOutputWithinBudget: boolean;
  };
  readonly pairs?: ReadonlyArray<{
    readonly pair: number;
    readonly order: ReadonlyArray<Role>;
    readonly candidateMinusReferenceMs: RunTiming;
  }>;
  readonly candidateMinusReferenceP95Ms?: RunTiming;
  readonly evidence: {
    readonly runnerBunVersion: string;
    readonly host: { readonly os: string; readonly arch: string; readonly kernel: string };
    readonly cpuBefore: CpuSnapshot;
    readonly cpuAfter: CpuSnapshot;
    readonly candidate: BinaryIdentity;
    readonly reference?: BinaryIdentity;
    readonly cacheNote: string;
  };
};

type ObservedFile = { readonly value: string | null; readonly unavailableReason: string | null };
type CpuSnapshot = {
  readonly loadAverage: ReadonlyArray<number>;
  readonly cgroupCpuStat: ObservedFile;
  readonly cgroupCpuMax: ObservedFile;
  readonly cpuPressure: ObservedFile;
};
type BinaryIdentity = { readonly path: string; readonly bytes: number; readonly sha256: string };

const observedFile = async (path: string): Promise<ObservedFile> => {
  try {
    return { value: (await readFile(path, "utf8")).trim(), unavailableReason: null };
  } catch (error) {
    return {
      value: null,
      unavailableReason: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const cpuSnapshot = async (): Promise<CpuSnapshot> => ({
  loadAverage: loadavg(),
  cgroupCpuStat: await observedFile("/sys/fs/cgroup/cpu.stat"),
  cgroupCpuMax: await observedFile("/sys/fs/cgroup/cpu.max"),
  cpuPressure: await observedFile("/proc/pressure/cpu"),
});

const identifyBinary = async (path: string): Promise<BinaryIdentity> => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { path, bytes: (await stat(path)).size, sha256: digest.digest("hex") };
};

export const summarizeStartup = (
  timings: ReadonlyArray<RunTiming>,
  startupBudgetMs: number,
  firstOutputBudgetMs: number,
) => {
  const startupP95Ms = percentile95(timings.map((timing) => timing.startupMs));
  const firstOutputP95Ms = percentile95(timings.map((timing) => timing.firstOutputMs));
  return {
    startupP95Ms,
    firstOutputP95Ms,
    startupWithinBudget: startupP95Ms < startupBudgetMs,
    firstOutputWithinBudget: firstOutputP95Ms < firstOutputBudgetMs,
  };
};

const usage = `Usage: bun run scripts/bench-opentui-startup.ts [options]

Options:
  --binary <path>                  Linux x64 compiled binary (default: core/dist/lando)
  --compare-binary <path>          Reference binary for alternating paired samples
  --baseline <path>                Baseline JSON path (default: scripts/bench-baselines.json)
  --runs <n>                       Process samples (default: baseline runs)
  --startup-budget-ms <n>          End-to-end p95 budget (default: baseline startupBudgetMs)
  --first-output-budget-ms <n>     First-output p95 budget (default: baseline firstOutputBudgetMs)
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
  let compareBinary: string | undefined;
  let baselinePath = DEFAULT_BASELINE;
  let runs: number | undefined;
  let startupBudgetMs: number | undefined;
  let firstOutputBudgetMs: number | undefined;
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
    else if (arg === "--compare-binary") compareBinary = resolve(value());
    else if (arg === "--baseline") baselinePath = resolve(value());
    else if (arg === "--runs") runs = positiveInteger(value(), arg);
    else if (arg === "--startup-budget-ms") startupBudgetMs = positiveNumber(value(), arg);
    else if (arg === "--first-output-budget-ms") firstOutputBudgetMs = positiveNumber(value(), arg);
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown option ${arg}`);
  }

  return {
    binary,
    ...(compareBinary === undefined ? {} : { compareBinary }),
    baselinePath,
    ...(runs === undefined ? {} : { runs }),
    ...(startupBudgetMs === undefined ? {} : { startupBudgetMs }),
    ...(firstOutputBudgetMs === undefined ? {} : { firstOutputBudgetMs }),
    json,
  };
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
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<RunTiming> => {
  const start = performance.now();
  let firstOutputMs: number | undefined;
  const proc = Bun.spawn({
    cmd: [input.binary, ...input.command],
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

export const runBenchmark = async (
  options: Options,
  baseline: Baseline,
): Promise<Omit<Summary, "evidence">> => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "lando-opentui-startup-"));
  try {
    const runs = options.runs ?? baseline.runs;
    const startupBudgetMs = options.startupBudgetMs ?? baseline.startupBudgetMs;
    const firstOutputBudgetMs = options.firstOutputBudgetMs ?? baseline.firstOutputBudgetMs;
    const timings: Record<Role, RunTiming[]> = { candidate: [], reference: [] };
    const samples: Array<RunTiming & { pair: number; role: Role; order: number }> = [];
    const pairs: Array<{ pair: number; order: ReadonlyArray<Role>; candidateMinusReferenceMs: RunTiming }> =
      [];
    const envFor = (role: Role) => ({
      ...process.env,
      LANDO_USER_CONF_ROOT: resolve(sandbox, role, "config"),
      LANDO_USER_DATA_ROOT: resolve(sandbox, role, "data"),
      LANDO_USER_CACHE_ROOT: resolve(sandbox, role, "cache"),
    });
    await mkdir(resolve(sandbox, "candidate"));
    if (options.compareBinary !== undefined) await mkdir(resolve(sandbox, "reference"));
    const envs = { candidate: envFor("candidate"), reference: envFor("reference") };
    const recordSample = async (role: Role, pair: number, order: number): Promise<void> => {
      const binary = role === "candidate" ? options.binary : options.compareBinary;
      if (binary === undefined) throw new Error("Reference binary was not provided");
      try {
        const timing = await measureOne({ binary, command: baseline.command, cwd: sandbox, env: envs[role] });
        timings[role].push(timing);
        samples.push({ pair, role, order, ...timing });
      } catch (error) {
        throw new Error(
          `${role} binary ${binary}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    for (let index = 0; index < runs; index += 1) {
      if (options.compareBinary === undefined) {
        await recordSample("candidate", index + 1, 1);
        continue;
      }
      const order: readonly [Role, Role] =
        index % 2 === 0 ? ["candidate", "reference"] : ["reference", "candidate"];
      await recordSample(order[0], index + 1, 1);
      await recordSample(order[1], index + 1, 2);
      const candidate = timings.candidate.at(-1);
      const reference = timings.reference.at(-1);
      if (candidate === undefined || reference === undefined)
        throw new Error("Incomplete startup sample pair");
      pairs.push({
        pair: index + 1,
        order,
        candidateMinusReferenceMs: {
          startupMs: candidate.startupMs - reference.startupMs,
          firstOutputMs: candidate.firstOutputMs - reference.firstOutputMs,
        },
      });
    }
    const candidate = summarizeStartup(timings.candidate, startupBudgetMs, firstOutputBudgetMs);
    const reference =
      options.compareBinary === undefined
        ? undefined
        : summarizeStartup(timings.reference, startupBudgetMs, firstOutputBudgetMs);
    return {
      platform: baseline.platform,
      command: baseline.command,
      runs,
      startupP95Ms: candidate.startupP95Ms,
      firstOutputP95Ms: candidate.firstOutputP95Ms,
      startupWithinBudget: candidate.startupWithinBudget,
      firstOutputWithinBudget: candidate.firstOutputWithinBudget,
      startupBudgetMs,
      firstOutputBudgetMs,
      samples,
      ...(reference === undefined
        ? {}
        : {
            reference,
            pairs,
            candidateMinusReferenceP95Ms: {
              startupMs: candidate.startupP95Ms - reference.startupP95Ms,
              firstOutputMs: candidate.firstOutputP95Ms - reference.firstOutputP95Ms,
            },
          }),
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
};

const formatMs = (value: number): string =>
  `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}ms`;
const formatSignedMs = (value: number): string => `${value >= 0 ? "+" : ""}${formatMs(value)}`;

const formatSummary = (summary: Summary, passed = true): string =>
  [
    `OpenTUI startup benchmark ${passed ? "passed" : "failed"}`,
    `platform: ${summary.platform}`,
    `command: ${summary.command.join(" ")}`,
    `samples: ${summary.runs}`,
    `startup p95 ${formatMs(summary.startupP95Ms)} (budget ${formatMs(summary.startupBudgetMs)})`,
    `first output p95 ${formatMs(summary.firstOutputP95Ms)} (budget ${formatMs(summary.firstOutputBudgetMs)})`,
    ...(summary.reference === undefined
      ? []
      : [
          `reference startup p95 ${formatMs(summary.reference.startupP95Ms)} (${summary.reference.startupWithinBudget ? "within" : "over"} budget); first output p95 ${formatMs(summary.reference.firstOutputP95Ms)} (${summary.reference.firstOutputWithinBudget ? "within" : "over"} budget; diagnostic)`,
          `candidate - reference p95: startup ${formatSignedMs(summary.startupP95Ms - summary.reference.startupP95Ms)}; first output ${formatSignedMs(summary.firstOutputP95Ms - summary.reference.firstOutputP95Ms)}`,
        ]),
  ].join("\n");

const main = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  const baseline = await readBaseline(options.baselinePath);
  const ttyBaseline = await readTtyOverheadBaseline(options.baselinePath);
  const cpuBefore = await cpuSnapshot();
  const measurements = await runBenchmark(options, baseline);
  // Read binary bytes only after all scheduled timed children (including TTY, when run).
  const withEvidence = async (): Promise<Summary> => ({
    ...measurements,
    evidence: {
      runnerBunVersion: Bun.version,
      host: { os: platform(), arch: arch(), kernel: release() },
      cpuBefore,
      cpuAfter: await cpuSnapshot(),
      candidate: await identifyBinary(options.binary),
      ...(options.compareBinary === undefined
        ? {}
        : { reference: await identifyBinary(options.compareBinary) }),
      cacheNote:
        "Fresh child process per sample; isolated Lando roots. No warmups or retries. OS page cache is unmanaged; this is not a cold-disk measurement.",
    },
  });
  if (!measurements.startupWithinBudget || !measurements.firstOutputWithinBudget) {
    const summary = await withEvidence();
    if (options.json) process.stderr.write(`${JSON.stringify({ ok: false, ...summary })}\n`);
    else process.stderr.write(`${formatSummary(summary, false)}\n`);
    process.exitCode = 1;
    return;
  }
  const ttyRendererOverhead = await runTtyOverheadBenchmark(options, ttyBaseline);
  const summary = await withEvidence();
  const overheadLine = `median TTY ${formatMs(ttyRendererOverhead.ttyMedianMs)} - piped ${formatMs(ttyRendererOverhead.pipedMedianMs)} = ${formatMs(ttyRendererOverhead.overheadMs)} (budget ${formatMs(ttyRendererOverhead.overheadBudgetMs)})`;
  if (!ttyRendererOverhead.ok) {
    if (options.json)
      process.stderr.write(`${JSON.stringify({ ok: false, ...summary, ttyRendererOverhead })}\n`);
    else
      process.stderr.write(
        `${formatSummary(summary)}\nTTY renderer overhead benchmark failed: ${overheadLine}\n`,
      );
    process.exitCode = 1;
    return;
  }
  if (options.json)
    process.stdout.write(`${JSON.stringify({ ok: true, ...summary, ttyRendererOverhead })}\n`);
  else process.stdout.write(`${formatSummary(summary)}\nTTY renderer overhead passed: ${overheadLine}\n`);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
