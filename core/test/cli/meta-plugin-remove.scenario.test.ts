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
