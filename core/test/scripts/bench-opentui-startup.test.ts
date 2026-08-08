import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const benchScript = resolve(repoRoot, "scripts/bench-opentui-startup.ts");
const trackedBaseline = resolve(repoRoot, "scripts/bench-baselines.json");

const writeFakeBinary = async (dir: string): Promise<string> => {
  const path = join(dir, "fake-lando");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'sleep "${LANDO_FAKE_FIRST_OUTPUT_SECONDS:-0.001}"',
      "printf 'fake startup output\\n'",
      'sleep "${LANDO_FAKE_EXIT_SECONDS:-0.001}"',
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
};

const writeBaseline = async (
  dir: string,
  openTuiStartup?: {
    readonly runs: number;
    readonly startupBudgetMs: number;
    readonly firstOutputBudgetMs: number;
  },
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
