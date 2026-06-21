import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseInitSourceFlags } from "../../src/cli/commands/init-source.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-git-source-")));
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
    env: { ...process.env, LANDO_USER_DATA_ROOT: join(cwd, "lando-data") },
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

describe("lando init git source parsing", () => {
  test("shared parser maps --source=git --url --path into InitAppOptions fields", () => {
    expect(
      parseInitSourceFlags({ source: "git", url: "https://example.test/repo.git", path: "packages/foo" }),
    ).toEqual({ source: "git", url: "https://example.test/repo.git", path: "packages/foo" });
  });

  test("shared parser rejects --source=git without --url with one message", () => {
    expect(() => parseInitSourceFlags({ source: "git" })).toThrow(
      "lando init --source=git requires --url=<git-url>.",
    );
  });

  test("OCLIF path reports the shared --source=git missing --url message", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--source=git", "--no-interactive"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lando init --source=git requires --url=<git-url>.");
    });
  });
});

describe("lando init git source dispatch parity", () => {
  test("compiled dispatch reports the shared --source=git missing --url message", async () => {
    const { runCli } = await import("../../src/cli/run.ts");
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    const previousExitCode = process.exitCode;
    try {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
        chunk: string | Uint8Array,
      ) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof process.stderr.write;
      process.exitCode = undefined;
      await runCli({
        argv: ["init", "--source=git", "--no-interactive"],
        rootUrl: "file:///$bunfs/lando.ts",
      });
      expect(process.exitCode).toBe(1);
      expect(writes.join("")).toContain("lando init --source=git requires --url=<git-url>.");
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
      process.exitCode = previousExitCode;
    }
  });

  test("initApp resolves a git recipe through manifest parsing before the existing renderer boundary", async () => {
    await withTempCwd(async (dir) => {
      const { initApp } = await import("../../src/cli/commands/init.ts");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
      try {
        let clonedUrl = "";
        await expect(
          initApp({
            cwd: dir,
            full: false,
            source: "git",
            url: "https://example.test/recipe.git",
            userDataRoot: join(dir, "data"),
            name: "git-app",
            nonInteractive: true,
            gitRecipeCloner: {
              clone: async ({ url, stagingDir }) => {
                clonedUrl = url;
                await Bun.write(
                  join(stagingDir, "recipe.yml"),
                  "id: git-recipe\ntitle: Git Recipe\ndescription: Parsed before render.\nversion: 0.0.1\nprompts:\n  - name: name\n    type: text\n    message: App name\nfiles:\n  - src: .lando.yml\n    dest: .lando.yml\n",
                );
                return { commitSha: "123abc" };
              },
            },
          }),
        ).rejects.toThrow(
          'Recipe file rendering for "https://example.test/recipe.git" is not implemented yet',
        );
        expect(clonedUrl).toBe("https://example.test/recipe.git");
      } finally {
        if (previousDataRoot === undefined) process.env.LANDO_USER_DATA_ROOT = undefined;
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });
});
