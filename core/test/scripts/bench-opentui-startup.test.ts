import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const benchScript = resolve(repoRoot, "scripts/bench-opentui-startup.ts");

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

const runBench = async (
  binary: string,
  budgets: { readonly startupMs: number; readonly firstOutputMs: number },
  env: NodeJS.ProcessEnv = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      benchScript,
      "--binary",
      binary,
      "--runs",
      "3",
      "--startup-budget-ms",
      String(budgets.startupMs),
      "--first-output-budget-ms",
      String(budgets.firstOutputMs),
    ],
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
  test("reports stable p95 startup and first-output budgets for the canonical command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-opentui-startup-pass-"));
    try {
      const binary = await writeFakeBinary(dir);

      const result = await runBench(binary, { startupMs: 1_000, firstOutputMs: 1_000 });

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
        binary,
        { startupMs: 1_000, firstOutputMs: 1 },
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
