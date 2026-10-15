import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { BaselineError, numberField, readBaselineRecord } from "./bench-startup-baseline.ts";

// The explicit renderer flag skips the app-free `version` fast path, so every
// sample constructs the default renderer.
export const TTY_OVERHEAD_COMMAND = ["version", "--renderer=lando"] as const;

type TtyOverheadBaseline = {
  readonly runs: number;
  readonly overheadBudgetMs: number;
};

export const readTtyOverheadBaseline = async (path: string): Promise<TtyOverheadBaseline> => {
  const record = await readBaselineRecord(path, "ttyRendererOverhead");
  const runs = numberField(record, "runs");
  if (!Number.isInteger(runs)) throw new BaselineError("Baseline field runs must be a positive integer");
  return { runs, overheadBudgetMs: numberField(record, "overheadBudgetMs") };
};

// Medians, not p95s: this gate runs on every PR, and a single noisy runner
// sample must not fail it. A TTY-only stall on every run still moves the median.
const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  const upper = sorted[Math.floor(sorted.length / 2)];
  if (lower === undefined || upper === undefined) throw new Error("Cannot compute a median without samples");
  return (lower + upper) / 2;
};

export const summarizeTtyOverhead = (input: {
  readonly piped: ReadonlyArray<number>;
  readonly tty: ReadonlyArray<number>;
  readonly overheadBudgetMs: number;
}) => {
  const pipedMedianMs = median(input.piped);
  const ttyMedianMs = median(input.tty);
  const overheadMs = ttyMedianMs - pipedMedianMs;
  return {
    ok: overheadMs <= input.overheadBudgetMs,
    pipedMedianMs,
    ttyMedianMs,
    overheadMs,
    overheadBudgetMs: input.overheadBudgetMs,
  };
};

const measureOne = async (input: {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
}): Promise<number> => {
  if (input.tty) {
    const chunks: Uint8Array[] = [];
    await using terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        chunks.push(data);
      },
    });
    // Start after PTY allocation so only the child's lifetime is compared.
    const start = performance.now();
    const proc = Bun.spawn({ cmd: [...input.cmd], cwd: input.cwd, env: input.env, terminal });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        `TTY overhead command failed with exit code ${exitCode}: ${new TextDecoder().decode(Buffer.concat(chunks))}`,
      );
    }
    return performance.now() - start;
  }
  const start = performance.now();
  const proc = Bun.spawn({
    cmd: [...input.cmd],
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Piped overhead command failed with exit code ${exitCode}: ${stderr}`);
  return performance.now() - start;
};

export const runTtyOverheadBenchmark = async (
  options: { readonly binary: string; readonly runs?: number },
  baseline: TtyOverheadBaseline,
) => {
  const sandbox = await mkdtemp(resolve(tmpdir(), "lando-tty-overhead-"));
  try {
    const env = {
      ...process.env,
      LANDO_USER_CONF_ROOT: resolve(sandbox, "config"),
      LANDO_USER_DATA_ROOT: resolve(sandbox, "data"),
      LANDO_USER_CACHE_ROOT: resolve(sandbox, "cache"),
    };
    const runs = options.runs ?? baseline.runs;
    const piped: number[] = [];
    const tty: number[] = [];
    const input = { cmd: [options.binary, ...TTY_OVERHEAD_COMMAND], cwd: sandbox, env };
    for (let index = 0; index < runs; index += 1) {
      piped.push(await measureOne({ ...input, tty: false }));
      tty.push(await measureOne({ ...input, tty: true }));
    }
    return {
      command: TTY_OVERHEAD_COMMAND,
      runs,
      ...summarizeTtyOverhead({ piped, tty, overheadBudgetMs: baseline.overheadBudgetMs }),
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
};
