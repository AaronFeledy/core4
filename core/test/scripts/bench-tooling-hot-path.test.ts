import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const benchScript = resolve(repoRoot, "scripts/bench-tooling-hot-path.ts");
const trackedBaseline = resolve(repoRoot, "scripts/bench-baselines.json");

const writeFakeBinary = async (dir: string): Promise<string> => {
  const path = join(dir, "fake-lando");
  await writeFile(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'sleep_ms="${LANDO_FAKE_SLEEP_MS:-1}"',
      'if [[ -n "${LANDO_FAKE_LOG:-}" ]]; then printf \'%s\\n\' "$*" >> "$LANDO_FAKE_LOG"; fi',
      'sleep "$(awk -v ms="$sleep_ms" \'BEGIN { printf "%.3f", ms / 1000 }\')"',
      "printf 'fake lando %s\\n' \"$*\"",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
};

const writeBaseline = async (dir: string, warmBudgetMs: number): Promise<string> => {
  const path = join(dir, "bench-baselines.json");
  await writeFile(
    path,
    JSON.stringify(
      {
        toolingHotPath: {
          description: "test baseline",
          platform: "linux-x64",
          command: ["bench-tool"],
          targetWarmP95Ms: 150,
          baselineWarmP95Ms: warmBudgetMs,
          allowedRegressionPercent: 25,
          coldRuns: 1,
          warmRuns: 3,
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

describe("bench-tooling-hot-path", () => {
  test("tracked baseline measures a tooling alias instead of a metadata command", async () => {
    const parsed = (await Bun.file(trackedBaseline).json()) as {
      readonly toolingHotPath: { readonly command: ReadonlyArray<string> };
    };

    expect(parsed.toolingHotPath.command).toEqual(["bench"]);
    expect(parsed.toolingHotPath.command).not.toContain("meta:version");
    expect(
      await Bun.file(
        resolve(repoRoot, "scripts/fixtures/tooling-hot-path/.lando/scripts/bench.bun.sh"),
      ).exists(),
    ).toBe(true);
  });

  test("prepares the app command cache before measuring tooling dispatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-bench-prepare-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir, 1_000);
      const log = join(dir, "invocations.log");

      const result = await runBench(["--binary", binary, "--baseline", baseline, "--runs", "1"], {
        LANDO_FAKE_LOG: log,
      });

      expect(result.exitCode).toBe(0);
      expect((await Bun.file(log).text()).trim().split("\n")).toEqual([
        "app:cache:refresh",
        "bench-tool",
        "bench-tool",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes when warm p95 stays within the tracked regression budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-bench-pass-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir, 1_000);

      const result = await runBench(["--binary", binary, "--baseline", baseline, "--runs", "3"], {
        LANDO_FAKE_SLEEP_MS: "1",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("tooling hot path benchmark passed");
      expect(result.stdout).toContain("warm p95");
      expect(result.stdout).toContain("target 150ms");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails when warm p95 regresses more than 25% over the tracked baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-bench-fail-"));
    try {
      const binary = await writeFakeBinary(dir);
      const baseline = await writeBaseline(dir, 1);

      const result = await runBench(["--binary", binary, "--baseline", baseline, "--runs", "3"], {
        LANDO_FAKE_SLEEP_MS: "35",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tooling hot path benchmark failed");
      expect(result.stderr).toContain("regression budget");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
