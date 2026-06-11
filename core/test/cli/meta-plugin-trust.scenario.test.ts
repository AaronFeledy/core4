import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { PluginTrustState } from "@lando/sdk/schema";
import { PluginTrustStore } from "@lando/sdk/services";

import { writePluginCommandCacheStrict } from "../../src/cache/command-index-writer.ts";
import {
  pluginTrust,
  pluginTrustAuthoringRoot,
  renderPluginTrustAuthoringRootResult,
  renderPluginTrustResult,
} from "../../src/cli/commands/plugin-trust.ts";
import { makePluginTrustStore } from "../../src/plugins/trust-store.ts";

let userConfRoot: string;

const trustLayer = (confRoot: string) =>
  Layer.succeed(PluginTrustStore, makePluginTrustStore(join(confRoot, "plugin-trust.yml")));

beforeEach(async () => {
  userConfRoot = await mkdtemp(join(tmpdir(), "lando-plugin-trust-"));
});

afterEach(async () => {
  if (userConfRoot !== undefined) await rm(userConfRoot, { recursive: true, force: true });
});

describe("meta:plugin:trust commands", () => {
  test("writes plugin trust entry to plugin-trust.yml", async () => {
    const result = await Effect.runPromise(
      pluginTrust({ name: "@lando/plugin-php" }).pipe(Effect.provide(trustLayer(userConfRoot))),
    );

    expect(result.kind).toBe("plugin");
    expect(renderPluginTrustResult(result)).toContain("trusted-plugin: @lando/plugin-php");
    expect(await readFile(join(userConfRoot, "plugin-trust.yml"), "utf8")).toContain(
      '  - "@lando/plugin-php"',
    );

    const store = await Effect.runPromise(PluginTrustStore.pipe(Effect.provide(trustLayer(userConfRoot))));
    expect(await Effect.runPromise(store.isPluginTrusted("@lando/plugin-php"))).toBe(true);
  });

  test("invalidates the plugin-command cache after trusting a plugin", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plugin-trust-cache-"));
    try {
      const cachePath = await Effect.runPromise(writePluginCommandCacheStrict({ cacheRoot }));

      await Effect.runPromise(
        pluginTrust({ name: "@lando/plugin-php", cacheRoot }).pipe(Effect.provide(trustLayer(userConfRoot))),
      );

      await expect(readFile(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("rejects relative authoring roots and persists absolute roots", async () => {
    const relativeExit = await Effect.runPromiseExit(
      pluginTrustAuthoringRoot({ path: "relative/plugin" }).pipe(Effect.provide(trustLayer(userConfRoot))),
    );
    expect(relativeExit._tag).toBe("Failure");

    const root = resolve(userConfRoot, "authoring", "plugin");
    const result = await Effect.runPromise(
      pluginTrustAuthoringRoot({ path: root }).pipe(Effect.provide(trustLayer(userConfRoot))),
    );

    expect(result.kind).toBe("authoring-root");
    expect(renderPluginTrustAuthoringRootResult(result)).toBe(`trusted-authoring-root: ${root}`);
    expect(await readFile(join(userConfRoot, "plugin-trust.yml"), "utf8")).toContain(`  - "${root}"`);
  });

  test("invalidates the plugin-command cache after trusting an authoring root", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plugin-trust-cache-"));
    try {
      const cachePath = await Effect.runPromise(writePluginCommandCacheStrict({ cacheRoot }));
      const root = resolve(userConfRoot, "authoring", "plugin");

      await Effect.runPromise(
        pluginTrustAuthoringRoot({ path: root, cacheRoot }).pipe(Effect.provide(trustLayer(userConfRoot))),
      );

      await expect(readFile(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("persists mixed-case trust entries in public-schema order", async () => {
    const layer = trustLayer(userConfRoot);
    await Effect.runPromise(pluginTrust({ name: "plugin-b" }).pipe(Effect.provide(layer)));
    await Effect.runPromise(pluginTrust({ name: "Plugin-A" }).pipe(Effect.provide(layer)));
    await Effect.runPromise(
      pluginTrustAuthoringRoot({ path: resolve(userConfRoot, "z-root") }).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(
      pluginTrustAuthoringRoot({ path: resolve(userConfRoot, "A-root") }).pipe(Effect.provide(layer)),
    );

    const store = await Effect.runPromise(PluginTrustStore.pipe(Effect.provide(layer)));
    const state = await Effect.runPromise(store.read);

    expect(Schema.decodeUnknownEither(PluginTrustState)(state)._tag).toBe("Right");
    expect(state.trustedPlugins).toEqual(["Plugin-A", "plugin-b"]);
    expect(state.trustedAuthoringRoots).toEqual([
      resolve(userConfRoot, "A-root"),
      resolve(userConfRoot, "z-root"),
    ]);
  });
});
