import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Config } from "@oclif/core";
import { runCommand } from "@oclif/test";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";

import { events, resetEvents } from "../fixtures/oclif-init/src/events.ts";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/oclif-init");

const loadConfig = async (): Promise<Config> => Config.load({ root: fixtureRoot, ignoreManifest: true });

const dispatch = async (id: string): Promise<void> => {
  const config = await loadConfig();
  await config.runHook("init", { argv: [], id });
  await config.runCommand(id, []);
};

describe("OCLIF init hook", () => {
  test("provides a provider runtime before the command runs", async () => {
    resetEvents();

    await dispatch("provider");

    expect(events).toEqual(["provider-command", "provider-effect", "provider-runtime"]);
  });

  test("minimal bootstrap does not provide runtime provider services", async () => {
    resetEvents();

    await expect(dispatch("minimal")).rejects.toThrow("RuntimeProvider");
    process.exitCode = 0;
    expect(events).toEqual(["minimal-command", "minimal-effect"]);
  });

  test("fails when the command class is missing static bootstrap", async () => {
    const result = await runCommand("missing", { root: fixtureRoot, ignoreManifest: true });

    expect(result.error).toBeInstanceOf(LandoRuntimeBootstrapError);
    process.exitCode = 0;
  });

  test("missing bootstrap prevents plain OCLIF commands from running", async () => {
    resetEvents();

    const result = await runCommand("plain-missing", { root: fixtureRoot, ignoreManifest: true });

    expect(result.error).toBeInstanceOf(LandoRuntimeBootstrapError);
    expect(events).toEqual([]);
    process.exitCode = 0;
  });
});
