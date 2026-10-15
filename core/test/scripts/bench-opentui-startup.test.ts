import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import type { Baseline } from "../../../scripts/bench-startup-baseline.ts";
import { TTY_OVERHEAD_COMMAND, summarizeTtyOverhead } from "../../../scripts/bench-tty-renderer-overhead.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const benchScript = resolve(repoRoot, "scripts/bench-opentui-startup.ts");
const trackedBaseline = resolve(repoRoot, "scripts/bench-baselines.json");

const writeFakeBinary = async (dir: string): Promise<string> => {
  const path = join(dir, "fake-lando");
  await writeFile(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "version --renderer=lando" ]] && test -t 1; then sleep "\${LANDO_FAKE_TTY_SECONDS:-0.001}"; fi
sleep "\${LANDO_FAKE_FIRST_OUTPUT_SECONDS:-0.001}"
printf 'fake startup output\\n'
sleep "\${LANDO_FAKE_EXIT_SECONDS:-0.001}"\n`,
  );
  await chmod(path, 0o755);
  return path;
};

const writeBaseline = async (
  dir: string,
  openTuiStartup?: Pick<Baseline, "runs" | "startupBudgetMs" | "firstOutputBudgetMs">,
  ttyRendererOverhead: unknown = { runs: 2, overheadBudgetMs: 150 },
): Promise<string> => {
  const path = join(dir, "bench-baselines.json");
  await writeFile(
    path,
    JSON.stringify(
      openTuiStartup === undefined
        ? { toolingHotPath: {} }
        : {
            openTuiStartup: {
              description: "test OpenTUI startup baseline",
              platform: "linux-x64",
              command: ["--version"],
              ...openTuiStartup,
            },
            ttyRendererOverhead,
          },
      null,
      2,
    ),
  );
  return path;
};

const runBench = async (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", benchScript, ...args],
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("bench-opentui-startup", () => {
  test("compares median samples at the inclusive overhead budget and ignores one outlier", () => {
    const samples = { piped: [10, 40, 20, 30], tty: [100, 900, 170, 160] };
    expect(summarizeTtyOverhead({ ...samples, overheadBudgetMs: 150 })).toEqual({
      ok: true,
      pipedMedianMs: 25,
      ttyMedianMs: 165,
      overheadMs: 140,
      overheadBudgetMs: 150,
    });
    expect(summarizeTtyOverhead({ ...samples, overheadBudgetMs: 140 }).ok).toBe(true);
    expect(summarizeTtyOverhead({ ...samples, overheadBudgetMs: 139 }).ok).toBe(false);
  });

  for (const [record, error] of [
    [null, "ttyRendererOverhead baseline must be an object"],
    [{ runs: 1.5, overheadBudgetMs: 150 }, "runs must be a positive integer"],
    [{ runs: 2, overheadBudgetMs: 0 }, "overheadBudgetMs must be a positive number"],
  ] as const) {
    test(`rejects invalid TTY overhead baseline: ${error}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "lando-tty-baseline-"));
      try {
        const baseline = await writeBaseline(
          dir,
          { runs: 1, startupBudgetMs: 1000, firstOutputBudgetMs: 1000 },
          record,
        );
        const result = await runBench(["--baseline", baseline]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(error);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("fails for TTY-only process-exit latency on the full CLI command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-tty-overhead-fail-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir, {
        runs: 2,
        startupBudgetMs: 1000,
        firstOutputBudgetMs: 1000,
      });
      const result = await runBench(["--binary", binary, "--baseline", baseline, "--json"], {
        LANDO_FAKE_TTY_SECONDS: "0.350",
      });
      expect(result.exitCode).toBe(1);
      const summary = JSON.parse(result.stderr);
      expect(summary.ttyRendererOverhead).toMatchObject({
        ok: false,
        command: TTY_OVERHEAD_COMMAND,
        runs: 2,
        overheadBudgetMs: 150,
      });
      expect(summary.ttyRendererOverhead.overheadMs).toBeGreaterThan(150);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tracked baseline pins the canonical OpenTUI startup gate", async () => {
    const parsed: unknown = await Bun.file(trackedBaseline).json();
    expect(parsed).toMatchObject({
      openTuiStartup: {
        description: expect.stringMatching(/.+/),
        platform: "linux-x64",
        command: ["--version"],
        runs: 20,
        startupBudgetMs: 50,
        firstOutputBudgetMs: 50,
      },
      ttyRendererOverhead: { runs: 20, overheadBudgetMs: 150 },
    });
  });

  test("uses the selected baseline command, runs, and budgets by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-opentui-startup-baseline-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir, {
        runs: 2,
        startupBudgetMs: 1_000,
        firstOutputBudgetMs: 1_000,
      });

      const result = await runBench(["--binary", binary, "--baseline", baseline]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("command: --version");
      expect(result.stdout).toContain("samples: 2");
      expect(result.stdout).toContain("startup p95");
      expect(result.stdout).toContain("budget 1000ms");
      expect(result.stdout).toContain("TTY renderer overhead passed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("CLI timing options override the selected baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-opentui-startup-overrides-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir, {
        runs: 1,
        startupBudgetMs: 1,
        firstOutputBudgetMs: 1,
      });

      const result = await runBench(
        [
          "--binary",
          binary,
          "--baseline",
          baseline,
          "--runs",
          "3",
          "--startup-budget-ms",
          "1000",
          "--first-output-budget-ms",
          "1000",
        ],
        { LANDO_FAKE_FIRST_OUTPUT_SECONDS: "0.030" },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("samples: 3");
      expect(result.stdout).toMatch(/startup p95 [\d.]+ms \(budget 1000ms\)/);
      expect(result.stdout).toMatch(/first output p95 [\d.]+ms \(budget 1000ms\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails clearly when the selected baseline omits openTuiStartup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-opentui-startup-missing-baseline-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir);

      const result = await runBench(["--binary", binary, "--baseline", baseline]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Baseline JSON must contain openTuiStartup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports stable p95 startup and first-output budgets for the canonical command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-opentui-startup-pass-"));
    try {
      const binary = await writeFakeBinary(dir);

      const result = await runBench([
        "--binary",
        binary,
        "--runs",
        "3",
        "--startup-budget-ms",
        "1000",
        "--first-output-budget-ms",
        "1000",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("OpenTUI startup benchmark passed");
      expect(result.stdout).toContain("command: --version");
      expect(result.stdout).toMatch(/startup p95 [\d.]+ms \(budget 1000ms\)/);
      expect(result.stdout).toMatch(/first output p95 [\d.]+ms \(budget 1000ms\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails when first output exceeds its perceived-performance budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-opentui-startup-fail-"));
    try {
      const binary = await writeFakeBinary(dir);

      const result = await runBench(
        ["--binary", binary, "--runs", "3", "--startup-budget-ms", "1000", "--first-output-budget-ms", "1"],
        { LANDO_FAKE_FIRST_OUTPUT_SECONDS: "0.030" },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OpenTUI startup benchmark failed");
      expect(result.stderr).toContain("first output p95");
      expect(result.stderr).toContain("budget 1ms");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
