import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";

import { pluginPublish, renderPluginPublishResult } from "../../src/cli/commands/plugin-publish.ts";

let root: string;

const recordingEventLayer = (events: LandoEvent[]) =>
  Layer.succeed(EventService, {
    publish: (event: LandoEvent) => Effect.sync(() => events.push(event)),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.fail(new Error("not implemented")),
  } as never);

interface Spawn {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
}

const writePlugin = async (dir: string, name = "@acme/lando-plugin-publish") => {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.2.3",
        type: "module",
        exports: { ".": "./src/index.ts" },
        landoPlugin: { name, version: "1.2.3", api: 4, entry: "src/index.ts" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(dir, "src", "index.ts"), "export const ok = true;\n");
};

// Write a fresh dist tree whose mtimes are newer than every source file so the
// artifact is considered up-to-date (no rebuild required).
const writeFreshDist = async (dir: string) => {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "index.js"), "export const ok = true;\n");
  await writeFile(join(dir, "dist", "index.d.ts"), "export declare const ok = true;\n");
  await writeFile(
    join(dir, "dist", "package.json"),
    `${JSON.stringify({ name: "@acme/lando-plugin-publish", version: "1.2.3" }, null, 2)}\n`,
  );
  const future = new Date(Date.now() + 60_000);
  for (const file of ["index.js", "index.d.ts", "package.json"])
    await utimes(join(dir, "dist", file), future, future);
};

const makeBuildingSpawner = (spawns: Spawn[]) => ({
  spawn: async ({ cmd, cwd }: { readonly cmd: ReadonlyArray<string>; readonly cwd: string }) => {
    spawns.push({ cmd, cwd });
    if (cmd.includes("build")) {
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "dist", "index.js"), "export const ok = true;\n");
    }
    if (cmd.includes("tsc"))
      await writeFile(join(root, "dist", "index.d.ts"), "export declare const ok = true;\n");
    return { exitCode: 0 };
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-publish-"));
});

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:publish command", () => {
  test("dry-run prints package contents, registry, tag, validation and skips network publish", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const events: LandoEvent[] = [];
    const spawns: Spawn[] = [];

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        execPath: "/opt/bun",
        dryRun: true,
        noTest: true,
        spawner: makeBuildingSpawner(spawns),
      }).pipe(Effect.provide(recordingEventLayer(events))),
    );

    expect(result.pluginName).toBe("@acme/lando-plugin-publish");
    expect(result.dryRun).toBe(true);
    expect(result.published).toBe(false);
    expect(result.rebuilt).toBe(false);
    expect(result.tested).toBe(false);
    expect(result.tag).toBe("latest");
    expect(result.registry).toBe("https://registry.npmjs.org/");
    expect(result.packageContents).toEqual(["dist/index.d.ts", "dist/index.js", "dist/package.json"]);
    expect(result.exitCode).toBe(0);
    // No network publish spawn at all on a fresh, --no-test dry run.
    expect(spawns).toEqual([]);
    expect(events.map((event) => event._tag)).toEqual([
      "cli-meta:plugin:publish-start",
      "cli-meta:plugin:publish-complete",
    ]);

    const rendered = renderPluginPublishResult(result);
    expect(rendered).toContain("plugin-publish: @acme/lando-plugin-publish");
    expect(rendered).toContain("registry: https://registry.npmjs.org/");
    expect(rendered).toContain("tag: latest");
    expect(rendered).toContain("dist/index.js");
    expect(rendered).toContain("dry-run");
  });

  test("dry-run does not require auth", async () => {
    await writePlugin(root);
    await writeFreshDist(root);

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        dryRun: true,
        noTest: true,
        userDataRoot: join(root, "no-auth-here"),
        spawner: makeBuildingSpawner([]),
      }),
    );

    expect(result.published).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  test("rebuilds stale artifacts and retests before publishing", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    // Make the source newer than the dist artifact so it is considered stale.
    const future = new Date(Date.now() + 120_000);
    await utimes(join(root, "src", "index.ts"), future, future);
    await mkdir(join(root, ".lando"), { recursive: true });
    await writeFile(
      join(root, "auth.json"),
      `${JSON.stringify({ registries: { "https://registry.npmjs.org/": { token: "secret-token" } } }, null, 2)}\n`,
    );
    const events: LandoEvent[] = [];
    const spawns: Spawn[] = [];

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        execPath: "/opt/bun",
        spawner: makeBuildingSpawner(spawns),
        authReader: async () => ({
          registries: { "https://registry.npmjs.org/": { token: "secret-token" } },
        }),
      }).pipe(Effect.provide(recordingEventLayer(events))),
    );

    expect(result.rebuilt).toBe(true);
    expect(result.tested).toBe(true);
    expect(result.published).toBe(true);
    expect(result.exitCode).toBe(0);
    const verbs = spawns.map((spawn) => spawn.cmd[1]);
    expect(verbs).toContain("build");
    expect(verbs).toContain("test");
    expect(verbs).toContain("publish");
    const publishSpawn = spawns.find((spawn) => spawn.cmd[1] === "publish");
    expect(publishSpawn?.cmd).toEqual(["/opt/bun", "publish", "--tag", "latest"]);
    expect(publishSpawn?.cwd).toBe(join(root, "dist"));
    expect(events.map((event) => event._tag)).toContain("cli-meta:plugin:publish-start");
    expect(events.map((event) => event._tag)).toContain("cli-meta:plugin:publish-complete");
  });

  test("--no-test skips the retest spawn", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const spawns: Spawn[] = [];

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        execPath: "/opt/bun",
        noTest: true,
        spawner: makeBuildingSpawner(spawns),
        authReader: async () => ({ registries: { "https://registry.npmjs.org/": { token: "t" } } }),
      }),
    );

    expect(result.tested).toBe(false);
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("test");
    expect(spawns.map((spawn) => spawn.cmd[1])).toContain("publish");
    expect(result.published).toBe(true);
  });

  test("missing auth produces a tagged remediation and never publishes", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const spawns: Spawn[] = [];

    const exit = await Effect.runPromiseExit(
      pluginPublish({
        cwd: root,
        noTest: true,
        userDataRoot: join(root, "empty-data-root"),
        spawner: makeBuildingSpawner(spawns),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginPublish to fail without auth");
    expect(JSON.stringify(exit.cause)).toContain("PluginPublishAuthError");
    expect(JSON.stringify(exit.cause)).toContain("plugin:login");
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("publish");
  });

  test("rejects an invalid registry before publishing", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const spawns: Spawn[] = [];

    const exit = await Effect.runPromiseExit(
      pluginPublish({
        cwd: root,
        noTest: true,
        registry: "not-a-url",
        spawner: makeBuildingSpawner(spawns),
        authReader: async () => ({ registries: { "not-a-url": { token: "t" } } }),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginPublish to fail on invalid registry");
    expect(JSON.stringify(exit.cause)).toContain("PluginPublishValidationError");
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("publish");
  });

  test("rejects an empty tag before publishing", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const spawns: Spawn[] = [];

    const exit = await Effect.runPromiseExit(
      pluginPublish({
        cwd: root,
        noTest: true,
        tag: "  ",
        spawner: makeBuildingSpawner(spawns),
        authReader: async () => ({ registries: { "https://registry.npmjs.org/": { token: "t" } } }),
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginPublish to fail on empty tag");
    expect(JSON.stringify(exit.cause)).toContain("PluginPublishValidationError");
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("publish");
  });

  test("resolves the registry from package.json publishConfig when not overridden", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "@acme/lando-plugin-publish",
          version: "1.2.3",
          type: "module",
          exports: { ".": "./src/index.ts" },
          publishConfig: { registry: "https://npm.acme.test/" },
          landoPlugin: {
            name: "@acme/lando-plugin-publish",
            version: "1.2.3",
            api: 4,
            entry: "src/index.ts",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        dryRun: true,
        noTest: true,
        spawner: makeBuildingSpawner([]),
      }),
    );

    expect(result.registry).toBe("https://npm.acme.test/");
  });
});
