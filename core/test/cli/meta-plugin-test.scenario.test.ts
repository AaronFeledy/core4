import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";

import { pluginTest, renderPluginTestResult } from "../../src/cli/commands/plugin-test.ts";
import { listTree } from "./_util/fs-tree.ts";

let root: string;

const recordingEventLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event: LandoEvent) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.fail(new Error("not implemented")),
    waitForAny: () => Effect.fail(new Error("not implemented")),
    query: () => Effect.succeed([]),
  } as never);

const writePlugin = async (dir: string, name = "@acme/lando-plugin-test") => {
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({
      name,
      version: "0.0.0",
      type: "module",
      landoPlugin: {
        name,
        version: "0.0.0",
        api: 4,
        entry: "src/index.ts",
      },
    })}\n`,
  );
  await writeFile(join(dir, "src", "index.ts"), "export const ok = true;\n");
  await writeFile(
    join(dir, "test", "plugin.test.ts"),
    "import { test } from 'bun:test'; test('ok', () => {});\n",
  );
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-test-"));
});

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:test command", () => {
  test("runs against the plugin root and never mutates global state under userDataRoot", async () => {
    await writePlugin(root);
    const dataRoot = join(root, "data");
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    try {
      const result = await Effect.runPromise(
        pluginTest({ cwd: root, spawner: { spawn: async () => ({ exitCode: 0 }) } }),
      );
      expect(result.exitCode).toBe(0);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previous;
    }

    expect(listTree(dataRoot)).toEqual([]);
  });

  test("detects the plugin root from a subdirectory and runs bun test through BunSelfRunner", async () => {
    await writePlugin(root);
    await mkdir(join(root, "src", "nested"), { recursive: true });
    const spawns: Array<{ readonly cmd: ReadonlyArray<string>; readonly cwd: string }> = [];

    const result = await Effect.runPromise(
      pluginTest({
        cwd: join(root, "src", "nested"),
        execPath: "/opt/bun",
        spawner: {
          spawn: async ({ cmd, cwd }) => {
            spawns.push({ cmd, cwd });
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(result.pluginName).toBe("@acme/lando-plugin-test");
    expect(result.pluginRoot).toBe(root);
    expect(result.exitCode).toBe(0);
    expect(spawns).toEqual([{ cmd: ["/opt/bun", "test"], cwd: root }]);
    const rendered = renderPluginTestResult(result);
    expect(rendered).toContain("plugin-test: @acme/lando-plugin-test");
    expect(rendered).toContain("result: passed");
  });

  test("skips nested non-plugin package roots while walking to the plugin package", async () => {
    await writePlugin(root);
    const nested = join(root, "fixtures", "plain-package");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), `${JSON.stringify({ name: "plain-package" })}\n`);
    const spawns: Array<{ readonly cwd: string }> = [];

    const result = await Effect.runPromise(
      pluginTest({
        cwd: nested,
        spawner: {
          spawn: async ({ cwd }) => {
            spawns.push({ cwd });
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(result.pluginRoot).toBe(root);
    expect(spawns).toEqual([{ cwd: root }]);
  });

  test("skips malformed and non-object package.json files while walking to the plugin package", async () => {
    await writePlugin(root);
    const nested = join(root, "fixtures", "bad-package");
    const child = join(nested, "child");
    await mkdir(child, { recursive: true });
    await writeFile(join(nested, "package.json"), "{ not json");
    await writeFile(join(child, "package.json"), "[]\n");
    const spawns: Array<{ readonly cwd: string }> = [];

    const result = await Effect.runPromise(
      pluginTest({
        cwd: child,
        spawner: {
          spawn: async ({ cwd }) => {
            spawns.push({ cwd });
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(result.pluginRoot).toBe(root);
    expect(spawns).toEqual([{ cwd: root }]);
  });

  test("validates keyword plugin packages through package.json landoPlugin metadata", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({
        name: "@acme/lando-plugin-keyword-package",
        version: "0.0.0",
        type: "module",
        keywords: ["lando", "lando-plugin"],
        lando: { manifest: "./plugin.yaml" },
        scripts: { test: "lando meta:plugin:test" },
        landoPlugin: {
          name: "@acme/lando-plugin-keyword",
          version: "0.0.0",
          api: 4,
          entry: "./src/index.ts",
        },
      })}\n`,
    );
    await writeFile(join(root, "plugin.yaml"), "this: file-is-not-the-validation-source\n");
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n");
    const spawns: Array<{ readonly cwd: string }> = [];

    const result = await Effect.runPromise(
      pluginTest({
        cwd: root,
        spawner: {
          spawn: async ({ cwd }) => {
            spawns.push({ cwd });
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(result.pluginName).toBe("@acme/lando-plugin-keyword");
    expect(result.pluginRoot).toBe(root);
    expect(spawns).toEqual([{ cwd: root }]);
  });

  test("detects a top-level manifest plugin whose optional entry is omitted", async () => {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "@acme/lando-plugin-bare", version: "0.0.0", api: 4 })}\n`,
    );
    const spawns: Array<{ readonly cwd: string }> = [];

    const result = await Effect.runPromise(
      pluginTest({
        cwd: root,
        spawner: {
          spawn: async ({ cwd }) => {
            spawns.push({ cwd });
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(result.pluginName).toBe("@acme/lando-plugin-bare");
    expect(result.pluginRoot).toBe(root);
    expect(spawns).toEqual([{ cwd: root }]);
  });

  test("passes positional paths before post-dash Bun arguments unchanged", async () => {
    await writePlugin(root);
    const spawns: Array<{ readonly cmd: ReadonlyArray<string> }> = [];

    await Effect.runPromise(
      pluginTest({
        cwd: root,
        argv: ["test/plugin.test.ts", "--", "--watch", "--timeout", "1000"],
        execPath: "/opt/bun",
        spawner: {
          spawn: async ({ cmd }) => {
            spawns.push({ cmd });
            return { exitCode: 0 };
          },
        },
      }),
    );

    expect(spawns[0]?.cmd).toEqual([
      "/opt/bun",
      "test",
      "test/plugin.test.ts",
      "--watch",
      "--timeout",
      "1000",
    ]);
  });

  test("publishes plugin-test and BunSelfRunner lifecycle events", async () => {
    await writePlugin(root, "@acme/lando-plugin-events");
    const events: LandoEvent[] = [];

    const result = await Effect.runPromise(
      pluginTest({
        cwd: root,
        argv: ["test/plugin.test.ts", "--", "--bail"],
        execPath: "/opt/bun",
        spawner: { spawn: async () => ({ exitCode: 7 }) },
      }).pipe(Effect.provide(recordingEventLayer(events))),
    );

    expect(result.exitCode).toBe(7);
    expect(events.map((event) => event._tag)).toEqual([
      "cli-meta:plugin:test-start",
      "pre-bun-self-exec",
      "post-bun-self-exec",
      "cli-meta:plugin:test-complete",
    ]);
    expect(events[0]).toMatchObject({
      _tag: "cli-meta:plugin:test-start",
      pluginName: "@acme/lando-plugin-events",
      argv: ["test", "test/plugin.test.ts", "--bail"],
    });
    expect(events[1]).toMatchObject({
      _tag: "pre-bun-self-exec",
      verb: "test",
      callerSubsystem: "plugin-authoring:meta:plugin:test:@acme/lando-plugin-events",
    });
    expect(events[3]).toMatchObject({
      _tag: "cli-meta:plugin:test-complete",
      pluginName: "@acme/lando-plugin-events",
      exitCode: 7,
    });
  });
});
