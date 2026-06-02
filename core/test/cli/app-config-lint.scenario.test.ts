import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderConfigLintResult } from "@lando/core/cli/operations";
import type { ConfigLintResult } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-config-lint-")));
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

describe("renderConfigLintResult", () => {
  const restoreExitCode = <T>(run: () => T): T => {
    const previous = process.exitCode;
    try {
      return run();
    } finally {
      process.exitCode = previous ?? 0;
    }
  };

  test("a valid result renders cleanly and does not flip the exit code", () => {
    const result: ConfigLintResult = { app: "ok", file: "/x/.lando.yml", valid: true, violations: [] };
    restoreExitCode(() => {
      const before = process.exitCode;
      const text = renderConfigLintResult(result, "text");
      expect(text).toContain("no canonical-schema violations");
      expect(process.exitCode).toBe(before);
    });
  });

  test("an invalid result sets process.exitCode = 1 (side-effect render)", () => {
    const result: ConfigLintResult = {
      app: "bad",
      file: "/x/.lando.yml",
      valid: false,
      violations: [{ path: "bogus", message: "is unexpected", suggestedFix: "Remove the unsupported key" }],
    };
    restoreExitCode(() => {
      process.exitCode = 0;
      const text = renderConfigLintResult(result, "text");
      expect(text).toContain("bogus");
      expect(text).toContain("fix:");
      expect(process.exitCode).toBe(1);
    });
  });

  test("the json format is a stable serialization of ConfigLintResult", () => {
    const result: ConfigLintResult = {
      app: "bad",
      file: "/x/.lando.yml",
      valid: false,
      violations: [{ path: "bogus", message: "is unexpected" }],
    };
    restoreExitCode(() => {
      const json = JSON.parse(renderConfigLintResult(result, "json")) as ConfigLintResult;
      expect(json).toEqual(result);
    });
  });
});

describe("lando app:config:lint (source dispatch)", () => {
  test("a clean Landofile exits 0 with a no-violations message", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: clean-app\nrecipe: lamp\n");
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no canonical-schema violations");
    });
  });

  test("--format=json on a clean Landofile emits a valid ConfigLintResult", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: json-app\nrecipe: lamp\n");
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as ConfigLintResult;
      expect(parsed.valid).toBe(true);
      expect(parsed.app).toBe("json-app");
      expect(parsed.violations).toHaveLength(0);
    });
  });

  test("a schema violation exits non-zero with a structured violation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: bad-app\nbogusKey: nope\n");
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("bogusKey");
    });
  });

  test("--format=json reports violations with path, message, and suggested fix", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: bad-app\nbogusKey: nope\n");
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      expect(result.exitCode).not.toBe(0);
      const parsed = JSON.parse(result.stdout) as ConfigLintResult;
      expect(parsed.valid).toBe(false);
      const violation = parsed.violations.find((entry) => entry.path.includes("bogusKey"));
      expect(violation).toBeDefined();
      expect(typeof violation?.message).toBe("string");
      expect(violation?.suggestedFix).toBeDefined();
    });
  });

  test("a missing Landofile fails with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(".lando.yml");
    });
  });
});
