import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Context, Effect, Exit, Layer, Queue, Stream } from "effect";

import { FailureRoleAnnotation, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { FileIoError } from "@lando/sdk/errors";
import { EventService, type LandoEvent } from "@lando/sdk/services";

import { pluginBuild, renderPluginBuildResult } from "../../src/cli/commands/plugin-build.ts";
import { listTree } from "./_util/fs-tree.ts";

let root: string;

const recordingEventLayer = (events: LandoEvent[]) =>
  Layer.succeed(
    EventService,
    EventService.of({
      publish: (event: LandoEvent) => Effect.sync(() => events.push(event)),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<LandoEvent>(),
      waitFor: () => Effect.fail(new Error("not implemented")),
      waitForAny: () => Effect.fail(new Error("not implemented")),
      query: () => Effect.succeed([]),
    } as never),
  );

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const declarationConfigPattern = /^\.lando-plugin-build\.[0-9a-f-]+\.tsconfig\.json$/u;
const declarationConfigPath = (cmd: ReadonlyArray<string>): string => {
  const name = cmd.at(-1);
  if (name === undefined || !declarationConfigPattern.test(name)) {
    throw new Error(`Expected a unique declaration config path in ${cmd.join(" ")}`);
  }
  return join(root, name);
};
const declarationConfigs = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(root)).filter((name) => declarationConfigPattern.test(name));
const replaceConfigWithDirectory = async (path: string): Promise<void> => {
  await rm(path);
  await mkdir(path);
  await writeFile(join(path, "marker"), "replacement\n");
};
const cleanupReasons = (cause: Cause.Cause<unknown>) =>
  cause.reasons.filter(
    (reason) =>
      !Cause.isInterruptReason(reason) &&
      Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation) === "cleanup",
  );

const writePlugin = async (dir: string, name = "@acme/lando-plugin-build") => {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
        landoPlugin: {
          name,
          version: "0.0.0",
          api: 4,
          entry: "src/index.ts",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(dir, "src", "index.ts"), "export const ok = true;\n");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-build-"));
});

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:build command", () => {
  test("builds into the authoring dist dir and never mutates global state under userDataRoot", async () => {
    await writePlugin(root);
    const dataRoot = join(root, "data");
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    try {
      const result = await Effect.runPromise(
        pluginBuild({
          cwd: root,
          execPath: "/opt/bun",
          spawner: {
            spawn: async ({ cmd }) => {
              if (cmd.includes("build"))
                await writeFile(join(root, "dist", "index.js"), "export const ok = true;\n");
              if (cmd.includes("tsc"))
                await writeFile(join(root, "dist", "index.d.ts"), "export declare const ok = true;\n");
              return { exitCode: 0 };
            },
          },
        }),
      );
      expect(result.outputs).toContain("dist/index.js");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previous;
    }

    expect(listTree(dataRoot)).toEqual([]);
  });

  test("builds package exports into deterministic dist artifacts with declarations", async () => {
    await writePlugin(root, "@acme/lando-plugin-build-events");
    const events: LandoEvent[] = [];
    const spawns: Array<{ readonly cmd: ReadonlyArray<string>; readonly cwd: string }> = [];

    const result = await Effect.runPromise(
      pluginBuild({
        cwd: root,
        execPath: "/opt/bun",
        spawner: {
          spawn: async ({ cmd, cwd }) => {
            spawns.push({ cmd, cwd });
            if (cmd.includes("build"))
              await writeFile(join(root, "dist", "index.js"), "export const ok = true;\n");
            if (cmd.includes("tsc"))
              await writeFile(join(root, "dist", "index.d.ts"), "export declare const ok = true;\n");
            return { exitCode: 0 };
          },
        },
      }).pipe(Effect.provide(recordingEventLayer(events))),
    );

    expect(result.pluginName).toBe("@acme/lando-plugin-build-events");
    expect(result.entrypoints).toEqual(["./src/index.ts"]);
    expect(result.outputs).toEqual(["dist/index.d.ts", "dist/index.js", "dist/package.json"]);
    expect(spawns[0]?.cmd).toEqual([
      "/opt/bun",
      "build",
      "./src/index.ts",
      "--outdir",
      "./dist",
      "--root",
      "./src",
      "--target",
      "bun",
      "--format",
      "esm",
      "--splitting",
      "--external",
      "@lando/sdk",
      "--external",
      "@lando/sdk/*",
      "--external",
      "effect",
      "--external",
      "effect/*",
    ]);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.cmd.slice(0, 4)).toEqual(["/opt/bun", "x", "tsc", "--project"]);
    expect(declarationConfigPath(spawns[1]?.cmd ?? [])).toBe(join(root, spawns[1]?.cmd.at(-1) ?? ""));
    expect(spawns.every((spawn) => spawn.cwd === root)).toBe(true);

    const packageJson = JSON.parse(await readFile(join(root, "dist", "package.json"), "utf8")) as {
      exports?: { "."?: { types?: string; import?: string } };
      landoPlugin?: { entry?: string };
    };
    expect(packageJson.exports?.["."]).toEqual({ types: "./index.d.ts", import: "./index.js" });
    expect(packageJson.landoPlugin?.entry).toBe("./index.js");
    expect(renderPluginBuildResult(result)).toContain("plugin-build: @acme/lando-plugin-build-events");
    expect(events.map((event) => event._tag)).toEqual([
      "cli-meta:plugin:build-start",
      "pre-bun-self-exec",
      "post-bun-self-exec",
      "pre-bun-self-exec",
      "post-bun-self-exec",
      "cli-meta:plugin:build-complete",
    ]);
    expect(await declarationConfigs()).toEqual([]);
  });

  test.each([false, true])(
    "removes the declaration config when the declaration build is interrupted (cleanup fails: %p)",
    async (cleanupFails) => {
      await writePlugin(root);
      const declarationStarted = Promise.withResolvers<void>();
      const declarationAborted = Promise.withResolvers<void>();
      const declarationSettled = Promise.withResolvers<{ readonly exitCode: number }>();
      const controller = new AbortController();
      let configPath = "";
      const running = Effect.runPromiseExit(
        pluginBuild({
          cwd: root,
          execPath: "/opt/bun",
          spawner: {
            spawn: async ({ cmd, signal }) => {
              if (cmd.includes("build")) return { exitCode: 0 };
              configPath = declarationConfigPath(cmd);
              if (cleanupFails) await replaceConfigWithDirectory(configPath);
              signal?.addEventListener("abort", () => declarationAborted.resolve(), { once: true });
              declarationStarted.resolve();
              return declarationSettled.promise;
            },
          },
        }),
        { signal: controller.signal },
      );

      try {
        await declarationStarted.promise;
        expect(await exists(configPath)).toBe(true);
        controller.abort();
        await declarationAborted.promise;
        declarationSettled.resolve({ exitCode: 0 });
        const exit = await running;
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) throw new Error("Expected declaration build to be interrupted");
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        if (cleanupFails) {
          expect(cleanupReasons(exit.cause)).toHaveLength(1);
          expect(failureOutcomeFromCause(exit.cause).error).toMatchObject({ _tag: "FileIoError" });
          expect(await exists(join(configPath, "marker"))).toBe(true);
        } else {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(await exists(configPath)).toBe(false);
        }
      } finally {
        controller.abort();
        declarationSettled.resolve({ exitCode: 0 });
        await running;
      }
    },
  );

  test("does not create a declaration config when the bundle build fails", async () => {
    await writePlugin(root);
    const spawns: string[][] = [];
    const result = await Effect.runPromise(
      pluginBuild({
        cwd: root,
        spawner: {
          spawn: async ({ cmd }) => {
            spawns.push([...cmd]);
            return { exitCode: 7 };
          },
        },
      }),
    );
    expect(result.exitCode).toBe(7);
    expect(spawns).toHaveLength(1);
    expect(await declarationConfigs()).toEqual([]);
  });

  test("removes the declaration config after a nonzero declaration exit", async () => {
    await writePlugin(root);
    let configPath = "";
    const result = await Effect.runPromise(
      pluginBuild({
        cwd: root,
        spawner: {
          spawn: async ({ cmd }) => {
            if (cmd.includes("build")) return { exitCode: 0 };
            configPath = declarationConfigPath(cmd);
            expect(await exists(configPath)).toBe(true);
            return { exitCode: 9 };
          },
        },
      }),
    );
    expect(result.exitCode).toBe(9);
    expect(await exists(configPath)).toBe(false);
    expect(await declarationConfigs()).toEqual([]);
  });

  test.each([false, true])(
    "removes the declaration config after a tagged declaration spawn failure (cleanup fails: %p)",
    async (cleanupFails) => {
      await writePlugin(root);
      const defect = new Error("declaration spawn failed");
      let configPath = "";
      const exit = await Effect.runPromiseExit(
        pluginBuild({
          cwd: root,
          spawner: {
            spawn: async ({ cmd }) => {
              if (cmd.includes("build")) return { exitCode: 0 };
              configPath = declarationConfigPath(cmd);
              if (cleanupFails) await replaceConfigWithDirectory(configPath);
              throw defect;
            },
          },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error("Expected declaration build to fail");
      const error = failureOutcomeFromCause(exit.cause).error;
      expect(error).toBeInstanceOf(FileIoError);
      if (error instanceof FileIoError) {
        expect(error.cause).toBe(defect);
        expect(error.path).toBe(process.execPath);
      }
      if (cleanupFails) {
        expect(failureOutcomeFromCause(exit.cause).additionalErrors).toMatchObject([
          { role: "cleanup", error: { _tag: "FileIoError" } },
        ]);
        expect(await exists(join(configPath, "marker"))).toBe(true);
      } else {
        expect(await exists(configPath)).toBe(false);
      }
    },
  );

  test("preserves an authored config at the legacy path", async () => {
    await writePlugin(root);
    const authoredPath = join(root, ".lando-plugin-build.tsconfig.json");
    const authoredContents = '{"authored":true}\n';
    await writeFile(authoredPath, authoredContents);
    const result = await Effect.runPromise(
      pluginBuild({
        cwd: root,
        spawner: { spawn: async () => ({ exitCode: 0 }) },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(authoredPath, "utf8")).toBe(authoredContents);
    expect(await declarationConfigs()).toEqual([]);
  });

  test("concurrent declaration builds only remove their own configs", async () => {
    await writePlugin(root);
    const firstStarted = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const firstSettled = Promise.withResolvers<{ readonly exitCode: number }>();
    const secondSettled = Promise.withResolvers<{ readonly exitCode: number }>();
    const paths: string[] = [];
    const spawner = {
      spawn: ({ cmd }: { readonly cmd: ReadonlyArray<string> }) => {
        if (cmd.includes("build")) return Promise.resolve({ exitCode: 0 });
        paths.push(declarationConfigPath(cmd));
        if (paths.length === 1) {
          firstStarted.resolve();
          return firstSettled.promise;
        }
        secondStarted.resolve();
        return secondSettled.promise;
      },
    };
    const first = Effect.runPromise(pluginBuild({ cwd: root, spawner }));
    let second: Promise<Awaited<typeof first>> | undefined;
    try {
      await firstStarted.promise;
      second = Effect.runPromise(pluginBuild({ cwd: root, spawner }));
      await secondStarted.promise;
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
      expect(await declarationConfigs()).toHaveLength(2);
      firstSettled.resolve({ exitCode: 0 });
      expect((await first).exitCode).toBe(0);
      expect(await exists(paths[0] ?? "")).toBe(false);
      expect(await exists(paths[1] ?? "")).toBe(true);
      secondSettled.resolve({ exitCode: 0 });
      expect((await second).exitCode).toBe(0);
      expect(await declarationConfigs()).toEqual([]);
    } finally {
      firstSettled.resolve({ exitCode: 0 });
      secondSettled.resolve({ exitCode: 0 });
      await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
    }
  });

  test.each([0, 7])("reports cleanup failure after declaration exit %i", async (exitCode) => {
    await writePlugin(root);
    let configPath = "";
    const exit = await Effect.runPromiseExit(
      pluginBuild({
        cwd: root,
        spawner: {
          spawn: async ({ cmd }) => {
            if (cmd.includes("build")) return { exitCode: 0 };
            configPath = declarationConfigPath(cmd);
            await replaceConfigWithDirectory(configPath);
            return { exitCode };
          },
        },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("Expected cleanup to fail");
    const failure = failureOutcomeFromCause(exit.cause);
    if (exitCode === 7) {
      expect(failure.error).toMatchObject({ _tag: "LandoCommandError", exitCode: 7 });
      expect(failure.additionalErrors).toHaveLength(1);
      expect(failure.additionalErrors[0]).toMatchObject({ role: "cleanup", error: { _tag: "FileIoError" } });
    } else {
      expect(failure.error).toMatchObject({ _tag: "FileIoError" });
    }
    expect(await exists(join(configPath, "marker"))).toBe(true);
  });

  test("matches dist export paths to declaration output for mixed export roots", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "lib"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "@acme/lando-plugin-build-mixed-roots",
          version: "0.0.0",
          type: "module",
          exports: { ".": "./src/index.ts", "./tools": "./lib/tools.ts" },
          landoPlugin: {
            name: "@acme/lando-plugin-build-mixed-roots",
            version: "0.0.0",
            api: 4,
            entry: "src/index.ts",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { module: "ESNext" }, include: ["src/**/*.ts"] }, null, 2)}\n`,
    );
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n");
    await writeFile(join(root, "lib", "tools.ts"), "export const tool = true;\n");
    let declarationConfig: unknown;

    const result = await Effect.runPromise(
      pluginBuild({
        cwd: root,
        execPath: "/opt/bun",
        spawner: {
          spawn: async ({ cmd }) => {
            if (cmd.includes("build")) {
              await mkdir(join(root, "dist", "src"), { recursive: true });
              await mkdir(join(root, "dist", "lib"), { recursive: true });
              await writeFile(join(root, "dist", "src", "index.js"), "export const ok = true;\n");
              await writeFile(join(root, "dist", "lib", "tools.js"), "export const tool = true;\n");
            }
            if (cmd.includes("tsc")) {
              declarationConfig = JSON.parse(await readFile(declarationConfigPath(cmd), "utf8")) as unknown;
              await writeFile(join(root, "dist", "src", "index.d.ts"), "export declare const ok: true;\n");
              await writeFile(join(root, "dist", "lib", "tools.d.ts"), "export declare const tool: true;\n");
            }
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(result.outputs).toEqual([
      "dist/lib/tools.d.ts",
      "dist/lib/tools.js",
      "dist/package.json",
      "dist/src/index.d.ts",
      "dist/src/index.js",
    ]);
    expect(declarationConfig).toEqual({
      extends: "./tsconfig.json",
      compilerOptions: {
        composite: false,
        incremental: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "./dist",
        rootDir: ".",
        noEmit: false,
      },
      include: ["./src/index.ts", "./lib/tools.ts"],
    });
    const packageJson = JSON.parse(await readFile(join(root, "dist", "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; import?: string }>;
      landoPlugin?: { entry?: string };
      types?: string;
    };
    expect(packageJson.exports?.["."]).toEqual({ types: "./src/index.d.ts", import: "./src/index.js" });
    expect(packageJson.exports?.["./tools"]).toEqual({
      types: "./lib/tools.d.ts",
      import: "./lib/tools.js",
    });
    expect(packageJson.types).toBe("./src/index.d.ts");
    expect(packageJson.landoPlugin?.entry).toBe("./src/index.js");
    expect(await declarationConfigs()).toEqual([]);
  });

  test("refuses source trees polluted by dist output before spawning", async () => {
    await writePlugin(root);
    await mkdir(join(root, "src", "dist"), { recursive: true });
    await writeFile(join(root, "src", "dist", "stale.js"), "export {};\n");
    const spawns: Array<ReadonlyArray<string>> = [];

    const exit = await Effect.runPromiseExit(
      pluginBuild({
        cwd: root,
        spawner: {
          spawn: async ({ cmd }) => {
            spawns.push(cmd);
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginBuild to fail");
    expect(JSON.stringify(exit.cause)).toContain("PluginBuildMixedTreeError");
    expect(JSON.stringify(exit.cause)).toContain("src/dist");
    expect(spawns).toEqual([]);
    expect(await exists(join(root, "dist", "package.json"))).toBe(false);
  });

  test("refuses dist entrypoints mixed with non-src source trees", async () => {
    await mkdir(join(root, "lib"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "@acme/lando-plugin-build-lib-mixed-tree",
          version: "0.0.0",
          type: "module",
          exports: { ".": "./lib/index.ts", "./built": "./dist/built.js" },
          landoPlugin: {
            name: "@acme/lando-plugin-build-lib-mixed-tree",
            version: "0.0.0",
            api: 4,
            entry: "lib/index.ts",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(root, "lib", "index.ts"), "export const ok = true;\n");
    await writeFile(join(root, "dist", "built.js"), "export const built = true;\n");
    const spawns: Array<ReadonlyArray<string>> = [];

    const exit = await Effect.runPromiseExit(
      pluginBuild({
        cwd: root,
        spawner: {
          spawn: async ({ cmd }) => {
            spawns.push(cmd);
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginBuild to fail");
    expect(JSON.stringify(exit.cause)).toContain("PluginBuildMixedTreeError");
    expect(JSON.stringify(exit.cause)).toContain("package.json#exports mixes source and dist entrypoints");
    expect(spawns).toEqual([]);
  });
});
