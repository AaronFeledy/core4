import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotImplementedError, RecipePostInitError, RecipeRunNotAllowedError } from "@lando/sdk/errors";

import type { BunSelfSpawner, BunSelfSpawnerOptions } from "../../src/cli/commands/bun-self-runner.ts";
import { type PostInitIO, redactBunOutput, runPostInit } from "../../src/recipes/post-init/runtime.ts";
import type { ChoicesCommandInput, ChoicesCommandRunner } from "../../src/recipes/prompts/choices-command.ts";

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-post-init-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeBufferedIO = (): PostInitIO & {
  out: (line: string) => void;
  outLines: string[];
  errLines: string[];
} => {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    out: (line) => {
      outLines.push(line);
    },
    err: (line) => {
      errLines.push(line);
    },
    outLines,
    errLines,
  };
};

interface RecordedSpawn {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const makeFakeSpawner = (
  exitCode: number,
): { readonly spawner: BunSelfSpawner; readonly calls: RecordedSpawn[] } => {
  const calls: RecordedSpawn[] = [];
  const spawner: BunSelfSpawner = {
    spawn: async (options: BunSelfSpawnerOptions) => {
      calls.push({ cmd: options.cmd, cwd: options.cwd, env: options.env });
      return { exitCode };
    },
  };
  return { spawner, calls };
};

const writePackageJson = async (dir: string, name = "fixture") => {
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name, version: "0.0.0" }, null, 2)}\n`);
};

describe("runPostInit — bun.install", () => {
  test("invokes the spawner with `install` argv in the destination cwd and sets BUN_BE_BUN", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir);
      const { spawner, calls } = makeFakeSpawner(0);

      const outcome = await runPostInit({
        actions: [{ type: "bun", verb: "install" }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "bun", verb: "install" }]);
      expect(calls.length).toBe(1);
      const [call] = calls;
      expect(call?.cmd).toEqual(["/fake/bun", "install"]);
      expect(call?.cwd).toBe(dir);
      expect(call?.env.BUN_BE_BUN).toBe("1");
      expect(call?.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY).toBe("1");
    });
  });

  test("resolves relative cwd under the destination", async () => {
    await withTempDir(async (dir) => {
      const inner = join(dir, "client");
      await mkdir(inner, { recursive: true });
      await writePackageJson(inner, "client");
      const { spawner, calls } = makeFakeSpawner(0);

      await runPostInit({
        actions: [{ type: "bun", verb: "install", cwd: "client" }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(calls[0]?.cwd).toBe(inner);
    });
  });

  test("rejects cwd containing `..` (path traversal) before realpath", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir);
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "install", cwd: "../escape" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("outside-destination");
        expect(caught.actionIndex).toBe(0);
        expect(caught.remediation).toContain("traversal");
      }
      expect(calls.length).toBe(0);
    });
  });

  test("rejects absolute cwd outside the destination", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (otherDir) => {
        await writePackageJson(dir);
        await writePackageJson(otherDir);
        const { spawner, calls } = makeFakeSpawner(0);

        let caught: unknown;
        try {
          await runPostInit({
            actions: [{ type: "bun", verb: "install", cwd: otherDir }],
            destination: dir,
            recipeId: "fixture",
            appName: "fixture",
            answers: {},
            spawner,
            execPath: "/fake/bun",
            env: { PATH: "/usr/bin" },
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RecipePostInitError);
        if (caught instanceof RecipePostInitError) {
          expect(caught.kind).toBe("outside-destination");
        }
        expect(calls.length).toBe(0);
      });
    });
  });

  test("rejects a symlink that escapes the destination", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (outside) => {
        await writePackageJson(dir);
        await writePackageJson(outside);
        await symlink(outside, join(dir, "linked"));
        const { spawner, calls } = makeFakeSpawner(0);

        let caught: unknown;
        try {
          await runPostInit({
            actions: [{ type: "bun", verb: "install", cwd: "linked" }],
            destination: dir,
            recipeId: "fixture",
            appName: "fixture",
            answers: {},
            spawner,
            execPath: "/fake/bun",
            env: { PATH: "/usr/bin" },
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RecipePostInitError);
        if (caught instanceof RecipePostInitError) {
          expect(caught.kind).toBe("outside-destination");
        }
        expect(calls.length).toBe(0);
      });
    });
  });

  test("rejects when cwd is missing package.json", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "install" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("missing-package-json");
      }
      expect(calls.length).toBe(0);
    });
  });

  test("surfaces a non-zero exit with retry guidance and preserves generated files", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir);
      await writeFile(join(dir, "server.js"), "// generated\n");
      const { spawner } = makeFakeSpawner(1);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "install" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("exit");
        expect(caught.exitCode).toBe(1);
        expect(caught.remediation).toContain("Network access is required");
        expect(caught.remediation).toContain("lifecycle scripts");
        expect(caught.remediation).toContain("rm -rf");
        expect(caught.remediation).toContain("Generated files were NOT removed");
      }

      expect(await Bun.file(join(dir, "server.js")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "package.json")).exists()).toBe(true);
    });
  });

  test("redacts NPM_TOKEN-style env values and registry URL credentials in remediation", () => {
    const raw =
      "Failed env: NPM_TOKEN=abc123 REG_PASSWORD=hunter2 url=https://user:hunter3@registry.example.com/pkg";
    const out = redactBunOutput(raw);
    expect(out).toContain("NPM_TOKEN=[REDACTED]");
    expect(out).toContain("REG_PASSWORD=[REDACTED]");
    expect(out).toContain("//user:[REDACTED]@");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("hunter3");
  });

  test("rejects bun action with `when:` set as NotImplementedError", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir);
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "install", when: "answers.skip" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NotImplementedError);
      if (caught instanceof NotImplementedError) {
        expect(caught.message).toContain("when");
        expect(caught.remediation).toContain("Remove `when:`");
      }
      expect(calls.length).toBe(0);
    });
  });
});

describe("runPostInit — bun.add", () => {
  test("spawns one `add` invocation per non-empty dependency category with the right flags", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      const outcome = await runPostInit({
        actions: [
          {
            type: "bun",
            verb: "add",
            dependencies: ["lodash", "zod"],
            devDependencies: ["typescript"],
            peerDependencies: ["react"],
            optionalDependencies: ["fsevents"],
          },
        ],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "bun", verb: "add" }]);
      expect(calls.map((c) => c.cmd)).toEqual([
        ["/fake/bun", "add", "lodash", "zod"],
        ["/fake/bun", "add", "--dev", "typescript"],
        ["/fake/bun", "add", "--peer", "react"],
        ["/fake/bun", "add", "--optional", "fsevents"],
      ]);
      expect(calls.every((c) => c.cwd === dir)).toBe(true);
      expect(calls.every((c) => c.env.BUN_BE_BUN === "1")).toBe(true);
    });
  });

  test("fails fast on a non-zero exit and does not run later categories", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(1);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "add", dependencies: ["lodash"], devDependencies: ["typescript"] }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("exit");
        expect(caught.actionVerb).toBe("add");
        expect(caught.exitCode).toBe(1);
      }
      expect(calls.length).toBe(1);
    });
  });
});

describe("runPostInit — bun.create", () => {
  test("spawns `create <template> <dest>` in the destination cwd", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      const outcome = await runPostInit({
        actions: [{ type: "bun", verb: "create", template: "react-app", dest: "site" }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "bun", verb: "create" }]);
      expect(calls[0]?.cmd).toEqual(["/fake/bun", "create", "react-app", join(dir, "site")]);
      expect(calls[0]?.cwd).toBe(dir);
    });
  });

  test("substitutes `${answers.<name>}` references in the template", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      await runPostInit({
        actions: [{ type: "bun", verb: "create", template: "${answers.framework}-app" }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: { framework: "vue" },
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(calls[0]?.cmd).toEqual(["/fake/bun", "create", "vue-app"]);
    });
  });

  test("rejects an unknown `${answers.<name>}` reference with invalid-argv", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "create", template: "${answers.missing}-app" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("invalid-argv");
      }
      expect(calls.length).toBe(0);
    });
  });

  test("rejects a dest that escapes the destination", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "create", template: "react-app", dest: "../escape" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("outside-destination");
      }
      expect(calls.length).toBe(0);
    });
  });

  test("resolves a relative dest against the execution cwd, not just the destination", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "sub"), { recursive: true });
      const { spawner, calls } = makeFakeSpawner(0);

      await runPostInit({
        actions: [{ type: "bun", verb: "create", template: "react-app", dest: "app", cwd: "sub" }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(calls[0]?.cwd).toBe(join(dir, "sub"));
      expect(calls[0]?.cmd).toEqual(["/fake/bun", "create", "react-app", join(dir, "sub", "app")]);
    });
  });

  test("rejects a dest whose symlinked parent escapes the destination", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (outside) => {
        await symlink(outside, join(dir, "link"));
        const { spawner, calls } = makeFakeSpawner(0);

        let caught: unknown;
        try {
          await runPostInit({
            actions: [{ type: "bun", verb: "create", template: "react-app", dest: "link/app" }],
            destination: dir,
            recipeId: "fixture",
            appName: "fixture",
            answers: {},
            spawner,
            execPath: "/fake/bun",
            env: { PATH: "/usr/bin" },
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RecipePostInitError);
        if (caught instanceof RecipePostInitError) {
          expect(caught.kind).toBe("outside-destination");
        }
        expect(calls.length).toBe(0);
      });
    });
  });

  test("rejects a template that resolves to a flag after answer substitution", async () => {
    for (const tpl of ["--evil", "  --evil"]) {
      await withTempDir(async (dir) => {
        const { spawner, calls } = makeFakeSpawner(0);

        let caught: unknown;
        try {
          await runPostInit({
            actions: [{ type: "bun", verb: "create", template: "${answers.tpl}" }],
            destination: dir,
            recipeId: "fixture",
            appName: "fixture",
            answers: { tpl },
            spawner,
            execPath: "/fake/bun",
            env: { PATH: "/usr/bin" },
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RecipePostInitError);
        if (caught instanceof RecipePostInitError) {
          expect(caught.kind).toBe("invalid-argv");
        }
        expect(calls.length).toBe(0);
      });
    }
  });

  test("rejects a template that resolves to empty after answer substitution", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "create", template: "${answers.tpl}" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: { tpl: "" },
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("invalid-argv");
        expect(caught.message).toContain("must not be empty");
      }
      expect(calls.length).toBe(0);
    });
  });
});

describe("runPostInit — bun.run", () => {
  test("spawns `run <script>` with args and requires package.json", async () => {
    await withTempDir(async (dir) => {
      await writePackageJson(dir);
      const { spawner, calls } = makeFakeSpawner(0);

      const outcome = await runPostInit({
        actions: [{ type: "bun", verb: "run", script: "build", args: ["--prod"] }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "bun", verb: "run" }]);
      expect(calls[0]?.cmd).toEqual(["/fake/bun", "run", "build", "--prod"]);
    });
  });

  test("rejects when package.json is missing", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "run", script: "build" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("missing-package-json");
      }
      expect(calls.length).toBe(0);
    });
  });
});

describe("runPostInit — bun.script", () => {
  test("runs a recipe-bundled script resolved under recipeRoot", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (recipeRoot) => {
        await mkdir(join(recipeRoot, "templates"), { recursive: true });
        const scriptPath = join(recipeRoot, "templates", "setup.bun.sh");
        await writeFile(scriptPath, "console.log('ok')\n");
        const { spawner, calls } = makeFakeSpawner(0);

        const outcome = await runPostInit({
          actions: [{ type: "bun", verb: "script", script: "templates/setup.bun.sh", args: ["--flag"] }],
          destination: dir,
          recipeRoot,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });

        expect(outcome.executed).toEqual([{ index: 0, type: "bun", verb: "script" }]);
        expect(calls[0]?.cmd).toEqual(["/fake/bun", "run", scriptPath, "--flag"]);
        expect(calls[0]?.cwd).toBe(dir);
      });
    });
  });

  test("rejects a script path that escapes the recipe root", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (recipeRoot) => {
        const { spawner, calls } = makeFakeSpawner(0);

        let caught: unknown;
        try {
          await runPostInit({
            actions: [{ type: "bun", verb: "script", script: "../escape.bun.sh" }],
            destination: dir,
            recipeRoot,
            recipeId: "fixture",
            appName: "fixture",
            answers: {},
            spawner,
            execPath: "/fake/bun",
            env: { PATH: "/usr/bin" },
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RecipePostInitError);
        if (caught instanceof RecipePostInitError) {
          expect(caught.kind).toBe("outside-recipe");
        }
        expect(calls.length).toBe(0);
      });
    });
  });

  test("rejects when no recipeRoot is available (e.g. bundled in-binary recipe)", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "script", script: "templates/setup.bun.sh" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("invalid-argv");
      }
      expect(calls.length).toBe(0);
    });
  });

  test("rejects when the resolved script file does not exist", async () => {
    await withTempDir(async (dir) => {
      await withTempDir(async (recipeRoot) => {
        const { spawner, calls } = makeFakeSpawner(0);

        let caught: unknown;
        try {
          await runPostInit({
            actions: [{ type: "bun", verb: "script", script: "templates/missing.bun.sh" }],
            destination: dir,
            recipeRoot,
            recipeId: "fixture",
            appName: "fixture",
            answers: {},
            spawner,
            execPath: "/fake/bun",
            env: { PATH: "/usr/bin" },
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RecipePostInitError);
        if (caught instanceof RecipePostInitError) {
          expect(caught.kind).toBe("invalid-argv");
        }
        expect(calls.length).toBe(0);
      });
    });
  });
});

describe("runPostInit — bun.x", () => {
  test("spawns `x <spec> <argv...>` in the destination cwd and sets BUN_BE_BUN", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      const outcome = await runPostInit({
        actions: [{ type: "bun", verb: "x", spec: "prettier", argv: ["--write", "."] }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "bun", verb: "x" }]);
      expect(calls[0]?.cmd).toEqual(["/fake/bun", "x", "prettier", "--write", "."]);
      expect(calls[0]?.cwd).toBe(dir);
      expect(calls[0]?.env.BUN_BE_BUN).toBe("1");
    });
  });

  test("allows an `x` spec listed in an explicit runs allowlist", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      await runPostInit({
        actions: [{ type: "bun", verb: "x", spec: "degit", argv: ["user/repo"] }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        runs: ["degit"],
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(calls[0]?.cmd).toEqual(["/fake/bun", "x", "degit", "user/repo"]);
    });
  });

  test("denies an `x` spec outside an explicit runs allowlist", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "x", spec: "rimraf", argv: ["/"] }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          runs: ["degit"],
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipeRunNotAllowedError);
      if (caught instanceof RecipeRunNotAllowedError) {
        expect(caught.commandId).toBe("rimraf");
        expect(caught.allowlist).toEqual(["degit"]);
      }
      expect(calls.length).toBe(0);
    });
  });

  test("warns and proceeds for an `x` spec when no runs allowlist is declared (allow by default)", async () => {
    await withTempDir(async (dir) => {
      const io = makeBufferedIO();
      const { spawner, calls } = makeFakeSpawner(0);

      await runPostInit({
        actions: [{ type: "bun", verb: "x", spec: "prettier" }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        io,
        spawner,
        execPath: "/fake/bun",
        env: { PATH: "/usr/bin" },
      });

      expect(calls[0]?.cmd).toEqual(["/fake/bun", "x", "prettier"]);
      expect(io.errLines).toHaveLength(1);
      expect(io.errLines[0]).toContain("prettier");
      expect(io.errLines[0]).toContain("outside the default runs allowlist");
    });
  });

  test("rejects a flag-like `x` spec with invalid-argv before spawning", async () => {
    await withTempDir(async (dir) => {
      const { spawner, calls } = makeFakeSpawner(0);

      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "bun", verb: "x", spec: "--evil" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          spawner,
          execPath: "/fake/bun",
          env: { PATH: "/usr/bin" },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("invalid-argv");
      }
      expect(calls.length).toBe(0);
    });
  });
});

describe("runPostInit — message", () => {
  test("writes text to io.out", async () => {
    await withTempDir(async (dir) => {
      const io = makeBufferedIO();
      const outcome = await runPostInit({
        actions: [{ type: "message", text: "Run `lando start` next." }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        io,
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "message" }]);
      expect(io.outLines).toEqual(["Run `lando start` next."]);
    });
  });
});

describe("runPostInit — Beta-deferred action types", () => {
  test("gitInit returns NotImplementedError without running it", async () => {
    await withTempDir(async (dir) => {
      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "gitInit" }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotImplementedError);
      if (caught instanceof NotImplementedError) {
        expect(caught.remediation).toContain("`git init`");
      }
    });
  });
});

describe("runPostInit — command", () => {
  const makeCommandRunner = (exitCode = 0) => {
    const calls: ChoicesCommandInput[] = [];
    const runner: ChoicesCommandRunner = async (input) => {
      calls.push(input);
      return { exitCode, stdout: "", stderr: "" };
    };
    return { runner, calls };
  };

  test("runs allowlisted command through the injected command runner", async () => {
    await withTempDir(async (dir) => {
      const { runner, calls } = makeCommandRunner();
      const outcome = await runPostInit({
        actions: [{ type: "command", cmd: "git", args: ["status", "--short"] }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        runs: ["git"],
        commandRunner: runner,
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "command" }]);
      expect(calls).toEqual([{ command: "git", args: ["status", "--short"] }]);
    });
  });

  test("denies command outside an explicit runs allowlist", async () => {
    await withTempDir(async (dir) => {
      const { runner, calls } = makeCommandRunner();
      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "command", cmd: "rm", args: ["-rf", "."] }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          runs: ["git"],
          commandRunner: runner,
        });
      } catch (cause) {
        caught = cause;
      }

      expect(caught).toBeInstanceOf(RecipeRunNotAllowedError);
      if (caught instanceof RecipeRunNotAllowedError) {
        expect(caught.commandId).toBe("rm");
        expect(caught.allowlist).toEqual(["git"]);
      }
      expect(calls).toEqual([]);
    });
  });

  test("warns and proceeds for a command outside the default runs allowlist", async () => {
    await withTempDir(async (dir) => {
      const { runner, calls } = makeCommandRunner();
      const io = makeBufferedIO();
      const outcome = await runPostInit({
        actions: [{ type: "command", cmd: "rsync", args: ["--version"] }],
        destination: dir,
        recipeId: "fixture",
        appName: "fixture",
        answers: {},
        io,
        commandRunner: runner,
      });

      expect(outcome.executed).toEqual([{ index: 0, type: "command" }]);
      expect(calls).toEqual([{ command: "rsync", args: ["--version"] }]);
      expect(io.errLines).toHaveLength(1);
      expect(io.errLines[0]).toContain("rsync");
      expect(io.errLines[0]).toContain("outside the default runs allowlist");
    });
  });

  test("non-zero command exits as RecipePostInitError", async () => {
    await withTempDir(async (dir) => {
      const { runner } = makeCommandRunner(7);
      let caught: unknown;
      try {
        await runPostInit({
          actions: [{ type: "command", cmd: "git", args: ["status"] }],
          destination: dir,
          recipeId: "fixture",
          appName: "fixture",
          answers: {},
          runs: ["git"],
          commandRunner: runner,
        });
      } catch (cause) {
        caught = cause;
      }

      expect(caught).toBeInstanceOf(RecipePostInitError);
      if (caught instanceof RecipePostInitError) {
        expect(caught.kind).toBe("exit");
        expect(caught.actionType).toBe("command");
        expect(caught.exitCode).toBe(7);
      }
    });
  });
});
