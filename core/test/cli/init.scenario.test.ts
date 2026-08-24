import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { InitTargetExistsError } from "@lando/core/errors";
import { ServiceName } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";
import { LandofileServiceLive } from "../../src/testing/engine-layers";

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
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
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

  test("uses the current folder name when --name is missing", async () => {
    await withTempCwd(async (dir) => {
      const appDir = join(dir, "my-site");
      await mkdir(appDir);
      const result = await runCli(["init", "--recipe=empty", "--no-interactive"], appDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created my-site at");
      expect(await Bun.file(join(appDir, ".lando.yml")).text()).toContain("name: my-site");
    });
  });

  test("resolves a relative answers file against InitAppOptions.cwd", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, "answers.json"), JSON.stringify({ name: "from-file" }), "utf8");
      const { initApp } = await import("../../src/cli/commands/init.ts");

      const result = await initApp({
        cwd: dir,
        full: true,
        answersFile: "answers.json",
        destination: join(dir, "from-file"),
        nonInteractive: true,
      });

      expect(result.appName).toBe("from-file");
      expect(await Bun.file(join(dir, "from-file", ".lando.yml")).exists()).toBe(true);
    });
  });

  test("writes a Landofile into a non-empty directory when that dest is free", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "existing"));
      await Bun.write(join(dir, "existing", "keep.txt"), "do not overwrite");

      const result = await runCli(["init", "--recipe=empty", "--no-interactive", "--name=existing"], dir);

      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(dir, "existing", "keep.txt")).text()).toBe("do not overwrite");
      expect(await Bun.file(join(dir, "existing", ".lando.yml")).exists()).toBe(true);
    });
  });

  test("refuses when the Landofile dest already exists", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "existing"));
      await Bun.write(join(dir, "existing", ".lando.yml"), "name: already\n");

      const result = await runCli(["init", "--full", "--name=existing"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Init target already has a Landofile");

      const directExit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: async () => {
            const { initApp } = await import("../../src/cli/commands/init.ts");
            await initApp({ cwd: dir, full: true, name: "existing", nonInteractive: true });
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
        }
      }
    });
  });

  test("skips the entire scaffold set when any scaffold dest exists", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "existing"));
      await Bun.write(join(dir, "existing", "package.json"), JSON.stringify({ name: "keep-me" }));

      const { initApp } = await import("../../src/cli/commands/init.ts");
      const result = await initApp({
        cwd: dir,
        full: true,
        name: "existing",
        nonInteractive: true,
      });

      expect(result.skippedScaffold).toEqual(["package.json", "server.js"]);
      expect(await Bun.file(join(dir, "existing", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "existing", "package.json")).json()).toEqual({ name: "keep-me" });
      expect(await Bun.file(join(dir, "existing", "server.js")).exists()).toBe(false);
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
