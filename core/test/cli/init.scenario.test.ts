import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError } from "@lando/core/errors";
import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { LandofileServiceLive } from "../../src/landofile/service.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-scenario-")));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
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

const discoverFrom = async (cwd: string) => {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await Effect.runPromise(
      Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
        Effect.provide(LandofileServiceLive),
      ),
    );
  } finally {
    process.chdir(previousCwd);
  }
};

describe("lando init --recipe (non-node-postgres)", () => {
  test("rejects file rendering for a local recipe that is not node-postgres", async () => {
    await withTempCwd(async (dir) => {
      await Bun.write(
        join(dir, "my-recipe", "recipe.yml"),
        "id: my-recipe\ntitle: My Recipe\ndescription: A custom recipe.\nversion: 0.0.1\n",
      );

      const { initApp } = await import("../../src/cli/commands/init.ts");
      let caught: unknown;
      try {
        await initApp({ cwd: dir, full: false, recipe: "./my-recipe", nonInteractive: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("not implemented yet");
    });
  });
});

describe("lando init --full", () => {
  test("scaffolds a Node and Postgres app", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--full", "--name=mvp"], dir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Error");
      expect(await Bun.file(join(dir, "mvp", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "mvp", "server.js")).exists()).toBe(true);

      const packageJson = await Bun.file(join(dir, "mvp", "package.json")).json();
      expect(packageJson.name).toBe("mvp");

      const landofile = await discoverFrom(join(dir, "mvp"));
      const web = landofile.services?.[ServiceName.make("web")];
      const database = landofile.services?.[ServiceName.make("database")];
      expect(web?.type).toBe("node:lts");
      expect(database?.type).toBe("postgres");
    });
  });

  test("fails non-interactively when --name is missing", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--full", "--no-interactive"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Missing required answer for prompt "name"');
      expect(result.stderr).toContain("--answer name=<value>");
      expect(await Bun.file(join(dir, "mvp")).exists()).toBe(false);
    });
  });

  test("refuses an existing non-empty directory with remediation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, "existing"), "placeholder");
      await rm(join(dir, "existing"));
      await Bun.write(join(dir, "existing", "keep.txt"), "do not overwrite");

      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => runCli(["init", "--full", "--name=existing"], dir),
          catch: (cause) => cause,
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const result = Exit.isSuccess(exit) ? exit.value : undefined;
      expect(result?.exitCode).toBe(1);
      expect(result?.stderr).toContain("Init target already exists");
      expect(result?.stderr).toContain("--force");

      const directExit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: async () => {
            const { initApp } = await import("../../src/cli/commands/init.ts");
            await initApp({ cwd: dir, full: true, name: "existing" });
          },
          catch: (cause) => cause,
        }),
      );
      expect(Exit.isFailure(directExit)).toBe(true);
      if (Exit.isFailure(directExit)) {
        const failure = Cause.failureOption(directExit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const value = failure.value;
          expect(value).toBeInstanceOf(InitTargetExistsError);
          if (value instanceof InitTargetExistsError) {
            expect(value.remediation).toContain("--force");
          }
        }
      }
    });
  });
});

describe("lando init --recipe (non-node-postgres)", () => {
  test("rejects file rendering for a local recipe that is not node-postgres", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "my-recipe");
      await mkdir(recipeDir, { recursive: true });
      await writeFile(
        join(recipeDir, "recipe.yml"),
        "id: my-recipe\ntitle: My Recipe\ndescription: A test local recipe.\nversion: 0.1.0\n",
      );

      const { initApp } = await import("../../src/cli/commands/init.ts");
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          recipe: "./my-recipe",
          name: "test-app",
          nonInteractive: true,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("not implemented yet");
    });
  });
});
