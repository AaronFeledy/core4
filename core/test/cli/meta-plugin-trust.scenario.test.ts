import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Layer } from "effect";

import { PluginTrustStore } from "@lando/sdk/services";

import {
  pluginTrust,
  pluginTrustAuthoringRoot,
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
    expect(await readFile(join(userConfRoot, "plugin-trust.yml"), "utf8")).toContain(`  - "${root}"`);
  });
});
