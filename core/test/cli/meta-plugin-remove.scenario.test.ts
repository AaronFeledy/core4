import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { pluginRemove, renderPluginRemoveResult } from "../../src/cli/commands/plugin-remove.ts";

let userDataRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

beforeEach(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-"));
});

afterEach(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
});

describe("meta:plugin:remove command", () => {
  test("reports a no-op when the plugin is not installed", async () => {
    const result = await Effect.runPromise(
      pluginRemove({ name: "@lando/plugin-ghost" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result.removed).toBe(false);
    expect(renderPluginRemoveResult(result)).toContain("not-installed");
  });

  test("rejects path-traversal names before touching disk", async () => {
    const sentinel = join(userDataRoot, "DO_NOT_DELETE.txt");
    await writeFile(sentinel, "sentinel");

    let removeCalled = false;
    const spawner = {
      uninstall: async () => {
        removeCalled = true;
        return { exitCode: 0, stderr: "" };
      },
    };
    const result = await Effect.runPromiseExit(
      pluginRemove({
        name: "../../../../etc",
        spawner,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result._tag).toBe("Failure");
    expect(removeCalled).toBe(false);
    expect(await Bun.file(sentinel).text()).toBe("sentinel");
  });

  test("rejects path-traversal names before invoking `bun remove` or `fs.rm`", async () => {
    let spawnerCalled = false;
    const spawner = {
      uninstall: async () => {
        spawnerCalled = true;
        return { exitCode: 0, stderr: "" };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "../../escape", spawner }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    expect(spawnerCalled).toBe(false);
  });

  test("rejects npm-illegal characters (semicolons, slashes) in plugin names", async () => {
    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "@evil/../escape" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("removes an installed plugin and clears it from the trust store", async () => {
    const pluginDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);

    const trustStore = new Set<string>(["@lando/plugin-php"]);
    const spawner = {
      uninstall: async () => ({ exitCode: 0, stderr: "" }),
    };
    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
        spawner,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result.removed).toBe(true);
    expect(trustStore.has("@lando/plugin-php")).toBe(false);
  });
});
