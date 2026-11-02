import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RecipeManifestValidationError } from "@lando/sdk/errors";
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

  test("source entry reports the shared --source=git missing --url message", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--source=git", "--no-interactive"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lando init --source=git requires --url=<git-url>.");
    });
  });
});

describe("lando init git source native CLI dispatch", () => {
  test("dispatch under a $bunfs root URL reports the --source=git missing --url message", async () => {
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
      expect(process.exitCode as number | undefined).toBe(1);
      expect(writes.join("")).toContain("lando init --source=git requires --url=<git-url>.");
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
      process.exitCode = previousExitCode ?? 0;
    }
  });

  test("initApp rejects invalid git config before writing", async () => {
    await withTempCwd(async (dir) => {
      const { initAppWithOwnerOnlyFileAccess: initApp } = await import("../_support/private-file-access.ts");
      const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
      process.env.LANDO_USER_DATA_ROOT = join(dir, "data");
      try {
        let clonedUrl = "";
        try {
          await initApp({
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
                  "id: git-recipe\ntitle: Git Recipe\ndescription: Parsed before render.\nversion: 0.0.1\nconfig: invalid\n",
                );
                return { commitSha: "a".repeat(40) };
              },
            },
          });
          throw new Error("expected initApp to reject invalid config");
        } catch (error) {
          expect(error).toBeInstanceOf(RecipeManifestValidationError);
          if (!(error instanceof RecipeManifestValidationError)) throw error;
          expect(error.source).toContain("recipe.yml");
        }
        expect(clonedUrl).toBe("https://example.test/recipe.git");
        expect(await Bun.file(join(dir, "git-app", ".lando.yml")).exists()).toBe(false);
      } finally {
        if (previousDataRoot === undefined) process.env.LANDO_USER_DATA_ROOT = undefined;
        else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
    });
  });
});
