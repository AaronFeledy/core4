import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { initApp } from "../../src/cli/commands/init.ts";
import { createBufferedPromptIO } from "../../src/recipes/prompts/io.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

interface RunOptions {
  readonly stdin?: string;
}

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : "pipe",
  });
  if (options.stdin !== undefined && proc.stdin !== undefined) {
    const writer = proc.stdin;
    writer.write(options.stdin);
    writer.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("lando init — interactive recipe selection (US-031 AC1)", () => {
  test("subprocess: scripted stdin picks recipe by id then answers prompts", async () => {
    await withTempCwd(async (dir) => {
      const scriptedStdin = "empty\nci-empty-app\n";
      const result = await runCli(["init"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Pick a recipe");
      expect(result.stdout).toContain("Empty Landofile");
      expect(result.stdout).toContain("Created ci-empty-app at");
      expect(await Bun.file(join(dir, "ci-empty-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "ci-empty-app", "server.js")).exists()).toBe(false);
    });
  });

  test("subprocess: scripted stdin picks recipe by index", async () => {
    await withTempCwd(async (dir) => {
      const scriptedStdin = "17\nidx-pick-app\n";
      const result = await runCli(["init"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created idx-pick-app at");
      expect(await Bun.file(join(dir, "idx-pick-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "idx-pick-app", "server.js")).exists()).toBe(false);
    });
  });

  test("subprocess: blank input picks the default recipe (node-postgres)", async () => {
    await withTempCwd(async (dir) => {
      const scriptedStdin = "\ndefault-app\n";
      const result = await runCli(["init"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created default-app at");
      expect(await Bun.file(join(dir, "default-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "default-app", "server.js")).exists()).toBe(true);
    });
  });

  test("buffered IO: invalid recipe re-prompts and then accepts a valid one", async () => {
    await withTempCwd(async (dir) => {
      const io = createBufferedPromptIO({ inputs: ["totally-bogus", "empty", "valid-app"] });
      const result = await initApp({
        cwd: dir,
        full: false,
        io,
        postInitIO: { out: () => {}, err: () => {} },
      });
      expect(result.appName).toBe("valid-app");
      expect(await Bun.file(join(dir, "valid-app", ".lando.yml")).exists()).toBe(true);
      const stderr = io.stderr();
      expect(stderr).toContain('no choice matches "totally-bogus"');
      const stdout = io.stdout();
      expect(stdout).toContain("Pick a recipe");
      expect(stdout).toContain("Empty Landofile");
    });
  });

  test("buffered IO: explicit --recipe bypasses the recipe-selection prompt", async () => {
    await withTempCwd(async (dir) => {
      const io = createBufferedPromptIO({ inputs: ["bypass-app"] });
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "empty",
        io,
        postInitIO: { out: () => {}, err: () => {} },
      });
      expect(result.appName).toBe("bypass-app");
      expect(io.stdout()).not.toContain("Pick a recipe");
    });
  });
});

describe("lando init — non-interactive recipe selection (US-031 AC2)", () => {
  test("subprocess: --no-interactive --recipe with --answer scaffolds without any prompt", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(
        ["init", "--no-interactive", "--recipe=empty", "--answer=name=ci-app"],
        dir,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Pick a recipe");
      expect(result.stdout).toContain("Created ci-app at");
      expect(await Bun.file(join(dir, "ci-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "ci-app", "server.js")).exists()).toBe(false);
    });
  });

  test("subprocess: --no-interactive without --recipe defaults to node-postgres", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--no-interactive", "--answer=name=default-ci"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Pick a recipe");
      expect(result.stdout).toContain("Created default-ci at");
      expect(await Bun.file(join(dir, "default-ci", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "default-ci", "server.js")).exists()).toBe(true);
    });
  });

  test("subprocess: --yes without --recipe accepts the default recipe", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--yes", "--answer=name=yes-app"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Pick a recipe");
      expect(result.stdout).toContain("Created yes-app at");
      expect(await Bun.file(join(dir, "yes-app", ".lando.yml")).exists()).toBe(true);
    });
  });
});
