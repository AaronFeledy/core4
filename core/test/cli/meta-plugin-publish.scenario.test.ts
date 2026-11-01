import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Queue, Stream } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";
import { withProcess } from "../_support/process-runner.ts";

import {
  type PluginPublishOptions,
  pluginPublish as publish,
  renderPluginPublishResult,
} from "../../src/cli/commands/plugin-publish.ts";
import { parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";
import { withEnvVar } from "../_support/temp-cwd";
import { listTree } from "./_util/fs-tree.ts";

let root: string;
const pluginPublish = (options: PluginPublishOptions = {}) =>
  publish({
    npmConfig: async () => parseNpmRegistryConfig(""),
    ...options,
  });

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

interface Spawn {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
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

const buildingProcess = (spawns: Spawn[]) =>
  withProcess(
    async ({
      cmd,
      cwd,
      env,
    }: {
      readonly cmd: ReadonlyArray<string>;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }) => {
      spawns.push({ cmd, cwd, env });
      if (cmd.includes("build")) {
        await mkdir(join(root, "dist"), { recursive: true });
        await writeFile(join(root, "dist", "index.js"), "export const ok = true;\n");
      }
      if (cmd.includes("tsc"))
        await writeFile(join(root, "dist", "index.d.ts"), "export declare const ok = true;\n");
      return { exitCode: 0 };
    },
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-plugin-publish-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("meta:plugin:publish command", () => {
  test("loads the npm user config when no config loader is injected", async () => {
    // Given
    await writePlugin(root);
    await writeFreshDist(root);
    const configPath = join(root, ".npmrc");
    await writeFile(configPath, "@acme:registry=https://user-config.test/\n");

    // When
    const result = await withEnvVar("NPM_CONFIG_USERCONFIG", configPath, () =>
      Effect.runPromise(publish({ cwd: root, dryRun: true, noTest: true }).pipe(buildingProcess([]))),
    );

    // Then
    expect(result.registry).toBe("https://user-config.test/");
    expect(result.published).toBe(false);
  });

  test.each([undefined, "https://override.test/"])(
    "resolves npm scope registry and token with caller override %s",
    async (override) => {
      await writePlugin(root);
      await writeFreshDist(root);
      const spawns: Spawn[] = [];
      const events: LandoEvent[] = [];
      const token = "literal-publish-token-not-in-env-1489";
      const result = await Effect.runPromise(
        pluginPublish({
          cwd: root,
          noTest: true,
          ...(override === undefined ? {} : { registry: override }),
          npmConfig: async () =>
            parseNpmRegistryConfig(
              `@acme:registry=https://scope.test/path/\nregistry=https://fallback.test/\n//scope.test/path/:_authToken=${token}\n//override.test/:_authToken=${token}`,
            ),
        }).pipe(buildingProcess(spawns), Effect.provide(recordingEventLayer(events))),
      );
      expect(result.registry).toBe(override ?? "https://scope.test/path/");
      expect(spawns[0]?.env.BUN_CONFIG_TOKEN).toBe(token);
      expect(JSON.stringify(spawns[0]?.cmd)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain(token);
    },
  );

  test("dry-run never writes under userDataRoot (writes only the authoring dist tree)", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const dataRoot = join(root, "isolated-data");

    await withEnvVar("LANDO_USER_DATA_ROOT", dataRoot, () =>
      Effect.runPromise(
        pluginPublish({
          cwd: root,
          dryRun: true,
          noTest: true,
        }).pipe(buildingProcess([])),
      ),
    );

    expect(listTree(dataRoot)).toEqual([]);
  });

  test("missing npm auth writes nothing under userDataRoot", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const dataRoot = join(root, "isolated-data");

    const exit = await withEnvVar("LANDO_USER_DATA_ROOT", dataRoot, () =>
      Effect.runPromiseExit(
        pluginPublish({
          cwd: root,
          noTest: true,
        }).pipe(buildingProcess([])),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(listTree(dataRoot)).toEqual([]);
  });

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
      }).pipe(buildingProcess(spawns), Effect.provide(recordingEventLayer(events))),
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
      }).pipe(buildingProcess([])),
    );

    expect(result.published).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  test("rebuilds stale artifacts and retests before publishing", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const future = new Date(Date.now() + 120_000);
    await utimes(join(root, "src", "index.ts"), future, future);
    const events: LandoEvent[] = [];
    const spawns: Spawn[] = [];

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        execPath: "/opt/bun",
        npmConfig: async () => parseNpmRegistryConfig("//registry.npmjs.org/:_authToken=secret-token"),
      }).pipe(buildingProcess(spawns), Effect.provide(recordingEventLayer(events))),
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
    expect(publishSpawn?.cmd).toEqual([
      "/opt/bun",
      "publish",
      expect.stringMatching(/^--config=.+/u),
      "--tag",
      "latest",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
    expect(publishSpawn?.cwd).toBe(join(root, "dist"));
    expect(publishSpawn?.env.BUN_CONFIG_TOKEN).toBe("secret-token");
    expect(events.map((event) => event._tag)).toContain("cli-meta:plugin:publish-start");
    expect(events.map((event) => event._tag)).toContain("cli-meta:plugin:publish-complete");
  });

  test("rebuilds when package.json is newer than the built package marker", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const future = new Date(Date.now() + 120_000);
    await utimes(join(root, "package.json"), future, future);
    const spawns: Spawn[] = [];

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        execPath: "/opt/bun",
        noTest: true,
        npmConfig: async () => parseNpmRegistryConfig("//registry.npmjs.org/:_authToken=secret-token"),
      }).pipe(buildingProcess(spawns)),
    );

    expect(result.rebuilt).toBe(true);
    expect(spawns.map((spawn) => spawn.cmd[1])).toContain("build");
    expect(spawns.map((spawn) => spawn.cmd[1])).toContain("publish");
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
        npmConfig: async () => parseNpmRegistryConfig("//registry.npmjs.org/:_authToken=t"),
      }).pipe(buildingProcess(spawns)),
    );

    expect(result.tested).toBe(false);
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("test");
    expect(spawns.map((spawn) => spawn.cmd[1])).toContain("publish");
    expect(result.published).toBe(true);
  });

  test("forwards the resolved publishConfig registry and matching auth token to bun publish", async () => {
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
    const spawns: Spawn[] = [];

    const result = await Effect.runPromise(
      pluginPublish({
        cwd: root,
        execPath: "/opt/bun",
        noTest: true,
        npmConfig: async () =>
          parseNpmRegistryConfig(
            "@acme:registry=https://fallback.test/\n//npm.acme.test/:_authToken=acme-token",
          ),
      }).pipe(buildingProcess(spawns)),
    );

    const publishSpawn = spawns.find((spawn) => spawn.cmd[1] === "publish");
    expect(result.registry).toBe("https://npm.acme.test/");
    expect(publishSpawn?.cmd).toEqual([
      "/opt/bun",
      "publish",
      expect.stringMatching(/^--config=.+/u),
      "--tag",
      "latest",
      "--registry",
      "https://npm.acme.test/",
    ]);
    expect(publishSpawn?.env.BUN_CONFIG_TOKEN).toBe("acme-token");
  });

  test("missing auth produces a tagged remediation and never publishes", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const events: LandoEvent[] = [];
    const spawns: Spawn[] = [];

    const exit = await Effect.runPromiseExit(
      pluginPublish({
        cwd: root,
        noTest: true,
      }).pipe(buildingProcess(spawns), Effect.provide(recordingEventLayer(events))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginPublish to fail without auth");
    expect(JSON.stringify(exit.cause)).toContain("PluginPublishAuthError");
    expect(JSON.stringify(exit.cause)).toContain(":_authToken to ${NPM_TOKEN}");
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("publish");
    expect(events.map((event) => event._tag)).toEqual([
      "cli-meta:plugin:publish-start",
      "cli-meta:plugin:publish-complete",
    ]);
    expect(events.at(-1)).toMatchObject({ published: false, exitCode: 1 });
  });

  test("rejects an invalid registry before publishing", async () => {
    await writePlugin(root);
    await writeFreshDist(root);
    const events: LandoEvent[] = [];
    const spawns: Spawn[] = [];

    const exit = await Effect.runPromiseExit(
      pluginPublish({
        cwd: root,
        noTest: true,
        registry: "not-a-url",
        npmConfig: async () => parseNpmRegistryConfig(""),
      }).pipe(buildingProcess(spawns), Effect.provide(recordingEventLayer(events))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Success") throw new Error("Expected pluginPublish to fail on invalid registry");
    expect(JSON.stringify(exit.cause)).toContain("PluginPublishValidationError");
    expect(spawns.map((spawn) => spawn.cmd[1])).not.toContain("publish");
    expect(events.map((event) => event._tag)).toEqual([
      "cli-meta:plugin:publish-start",
      "cli-meta:plugin:publish-complete",
    ]);
    expect(events.at(-1)).toMatchObject({ published: false, exitCode: 1 });
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
        npmConfig: async () => parseNpmRegistryConfig("//registry.npmjs.org/:_authToken=t"),
      }).pipe(buildingProcess(spawns)),
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
      }).pipe(buildingProcess([])),
    );

    expect(result.registry).toBe("https://npm.acme.test/");
  });
});
