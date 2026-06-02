import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderIncludesUpdateResult } from "@lando/core/cli/operations";
import type { IncludeUpdateReport } from "@lando/core/cli/operations";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-includes-update-cli-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
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

const restoreExitCode = <T>(run: () => T): T => {
  const previous = process.exitCode;
  try {
    return run();
  } finally {
    process.exitCode = previous ?? 0;
  }
};

describe("renderIncludesUpdateResult", () => {
  test("check-mode drift sets process.exitCode = 1", () => {
    const report: IncludeUpdateReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [
        {
          source: "github:acme/fragments/web.yml",
          resolved: "abc123",
          checksum: "f".repeat(64),
          status: "updated",
        },
      ],
      removed: [],
      drift: true,
      wrote: false,
      checkMode: true,
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      const text = renderIncludesUpdateResult(report, "text");
      expect(text).toContain("Lockfile is out of date");
      expect(process.exitCode).toBe(1);
    });
  });

  test("json format serializes the report", () => {
    const report: IncludeUpdateReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [],
      removed: [],
      drift: false,
      wrote: false,
      checkMode: false,
    };

    restoreExitCode(() => {
      const parsed = JSON.parse(renderIncludesUpdateResult(report, "json")) as IncludeUpdateReport;
      expect(parsed).toEqual(report);
    });
  });
});

describe("lando app:includes:update (source dispatch)", () => {
  test("a Landofile with no includes exits 0 with a no-remote-includes message", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:update"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no remote includes");
    });
  });

  test("a missing Landofile exits 1 with .lando.yml remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:includes:update"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(".lando.yml");
    });
  });

  test("--format=json with no includes emits a no-drift report", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:update", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as IncludeUpdateReport;
      expect(parsed.drift).toBe(false);
      expect(parsed.entries).toEqual([]);
    });
  });
});
