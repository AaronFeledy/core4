import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { AppIncludesUpdateResultSchema, renderIncludesUpdateResult } from "@lando/core/cli/operations";
import type { IncludeUpdateReport } from "@lando/core/cli/operations";
import { LandofileFormConflictError } from "@lando/core/errors";
import { appIncludesUpdate } from "../../src/cli/commands/app-includes-update.ts";
import type { GitIncludeCloner } from "../../src/landofile/includes.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const parseEnvelopeResult = <A>(stdout: string): A => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as A;
};

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

const withUserCacheRoot = async <T>(userCacheRoot: string, run: () => Promise<T>): Promise<T> => {
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = userCacheRoot;
  try {
    return await run();
  } finally {
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
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
      noNetwork: false,
      requestedSources: [],
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      const text = renderIncludesUpdateResult(report, "text");
      expect(text).toContain("Lockfile is out of date");
      expect(process.exitCode).toBe(1);
    });
  });

  test("AppIncludesUpdateResultSchema encodes the report faithfully", () => {
    const report: IncludeUpdateReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [],
      removed: [],
      drift: false,
      wrote: false,
      checkMode: false,
      noNetwork: false,
      requestedSources: [],
    };

    restoreExitCode(() => {
      const encoded = Schema.encodeSync(AppIncludesUpdateResultSchema)(report);
      expect(encoded).toEqual(report);
    });
  });
});

describe("lando app:includes:update (source dispatch)", () => {
  test("scoped user cache root leaves an originally absent value absent", async () => {
    // Given
    const originalCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
    Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");

    try {
      const scopedCacheRoot = join(tmpdir(), "lando-includes-update-scoped-cache");

      // When
      await withUserCacheRoot(scopedCacheRoot, async () => {
        expect(process.env.LANDO_USER_CACHE_ROOT).toBe(scopedCacheRoot);
      });

      // Then
      expect(Object.hasOwn(process.env, "LANDO_USER_CACHE_ROOT")).toBe(false);
    } finally {
      if (originalCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = originalCacheRoot;
    }
  });

  test("a Landofile with no includes exits 0 with a no-remote-includes message", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:update"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no remote includes");
    });
  });

  test("rejects non-object tooling flag metadata before updating includes", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: demo",
          "tooling:",
          "  echo:",
          "    cmd: echo hi",
          "    flags:",
          "      verbose: true",
          "",
        ].join("\n"),
      );

      const exit = await Effect.runPromiseExit(appIncludesUpdate({ cwd: dir }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect((failure.value as { _tag: string; message: string })._tag).toBe("NotImplementedError");
          expect((failure.value as { message: string }).message).toContain('Tooling flags entry "verbose"');
        }
      }
    });
  });

  test("same-layer YAML and TS forms fail with LandofileFormConflictError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: yaml-app\n");
      await writeFile(join(dir, ".lando.ts"), 'export default { name: "ts-app" };\n');

      const exit = await Effect.runPromiseExit(appIncludesUpdate({ cwd: dir }));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(LandofileFormConflictError);
        }
      }
    });
  });

  test("mixed YAML and TS layers gather remote includes from every authored layer", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.base.yml"),
        "name: mixed-app\nincludes:\n  - source: github:acme/base\n    path: fragment.yml\n",
      );
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default {",
          '  includes: [{ source: "github:acme/canonical", path: "fragment.yml" }],',
          "};",
          "",
        ].join("\n"),
      );
      const cloneUrls: string[] = [];
      const gitCloner: GitIncludeCloner = {
        clone: async ({ url, stagingDir }) => {
          cloneUrls.push(url);
          await mkdir(stagingDir, { recursive: true });
          await writeFile(join(stagingDir, "fragment.yml"), "services: {}\n", "utf8");
          return { commitSha: url.includes("/base.git") ? "base123" : "canonical456" };
        },
      };
      await withUserCacheRoot(join(dir, ".cache"), async () => {
        const report = await Effect.runPromise(appIncludesUpdate({ cwd: dir, deps: { gitCloner } }));

        expect(report.entries.map((entry) => entry.source).sort()).toEqual([
          "github:acme/base/fragment.yml",
          "github:acme/canonical/fragment.yml",
        ]);
        expect(cloneUrls.sort()).toEqual([
          "https://github.com/acme/base.git",
          "https://github.com/acme/canonical.git",
        ]);
      });
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
      const parsed = parseEnvelopeResult<IncludeUpdateReport>(result.stdout);
      expect(parsed.drift).toBe(false);
      expect(parsed.entries).toEqual([]);
      expect(parsed.noNetwork).toBe(false);
      expect(parsed.requestedSources).toEqual([]);
    });
  });

  test("an unknown positional source exits 1 and lists the known sources", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: demo\nincludes:\n  - source: github:acme/fragments\n    path: db.yml\n",
      );
      const result = await runCli(["app:includes:update", "bogus-source"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("bogus-source");
      expect(result.stderr).toContain("github:acme/fragments");
    });
  });

  test("--no-network --format=json runs offline and reports the flag", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:update", "--no-network", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      const parsed = parseEnvelopeResult<IncludeUpdateReport>(result.stdout);
      expect(parsed.noNetwork).toBe(true);
      expect(parsed.drift).toBe(false);
    });
  });
});
