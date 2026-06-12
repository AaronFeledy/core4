import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { renderIncludesVerifyResult } from "@lando/core/cli/operations";
import type { IncludeVerifyReport } from "@lando/core/cli/operations";
import { appIncludesVerify } from "../../src/cli/commands/app-includes-verify.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-includes-verify-cli-")));
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

describe("renderIncludesVerifyResult", () => {
  test("a mismatch sets process.exitCode = 1 and names the update command", () => {
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [
        {
          source: "github:acme/fragments/web.yml",
          status: "mismatch",
          expected: `old:${"a".repeat(64)}`,
          actual: `new:${"b".repeat(64)}`,
        },
      ],
      mismatches: [
        {
          _tag: "LandofileLockMismatchError",
          message: "Landofile include lock mismatch for github:acme/fragments/web.yml.",
          lockfile: "/x/.lando.lock.yml",
          source: "github:acme/fragments/web.yml",
          expected: `old:${"a".repeat(64)}`,
          actual: `new:${"b".repeat(64)}`,
          remediation:
            "Run lando app:includes:update to refresh .lando.lock.yml after reviewing the include change.",
        },
      ],
      ok: false,
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      const text = renderIncludesVerifyResult(report, "text");
      expect(text).toContain("Lockfile does not match");
      expect(text).toContain("app:includes:update");
      expect(process.exitCode).toBe(1);
    });
  });

  test("an ok report does not set a non-zero exit code", () => {
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [],
      mismatches: [],
      ok: true,
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      renderIncludesVerifyResult(report, "text");
      expect(process.exitCode).toBe(0);
    });
  });

  test("json format serializes the report including the mismatch schema", () => {
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [{ source: "a", status: "missing", expected: null, actual: "v:hash" }],
      mismatches: [
        {
          _tag: "LandofileLockMismatchError",
          message: "m",
          lockfile: "/x/.lando.lock.yml",
          source: "a",
          expected: "<missing>",
          actual: "v:hash",
          remediation: "r",
        },
      ],
      ok: false,
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      const parsed = JSON.parse(renderIncludesVerifyResult(report, "json")) as IncludeVerifyReport;
      expect(parsed).toEqual(report);
      expect(parsed.mismatches[0]?._tag).toBe("LandofileLockMismatchError");
    });
  });
});

describe("lando app:includes:verify (source dispatch)", () => {
  test("a Landofile with no includes verifies ok and exits 0", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:verify"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no remote includes");
    });
  });

  test("rejects unsupported tooling arg metadata before verifying includes", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: demo",
          "tooling:",
          "  echo:",
          "    cmd: echo hi",
          "    args:",
          "      target:",
          "        description: Deployment target",
          "",
        ].join("\n"),
      );

      const exit = await Effect.runPromiseExit(appIncludesVerify({ cwd: dir }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect((failure.value as { _tag: string; message: string })._tag).toBe("NotImplementedError");
          expect((failure.value as { message: string }).message).toContain(
            'Tooling args field "description"',
          );
        }
      }
    });
  });

  test("a missing Landofile exits 1 with .lando.yml remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:includes:verify"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(".lando.yml");
    });
  });

  test("--format=json with no includes emits an ok report", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:verify", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as IncludeVerifyReport;
      expect(parsed.ok).toBe(true);
      expect(parsed.entries).toEqual([]);
      expect(parsed.mismatches).toEqual([]);
    });
  });
});
