import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";

import { pluginBuild, renderPluginBuildResult } from "../../src/cli/commands/plugin-build.ts";

let root: string;

const recordingEventLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event: LandoEvent) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.fail(new Error("not implemented")),
  } as never);

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
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
    expect(spawns.map((spawn) => spawn.cmd)).toEqual([
      ["/opt/bun", "build", "./src/index.ts", "--outdir", "./dist", "--target", "bun", "--format", "esm"],
      [
        "/opt/bun",
        "x",
        "tsc",
        "--declaration",
        "--emitDeclarationOnly",
        "--outDir",
        "./dist",
        "--noEmit",
        "false",
      ],
    ]);
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
});
