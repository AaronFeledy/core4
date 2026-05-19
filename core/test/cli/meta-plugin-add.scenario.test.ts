import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { pluginAdd } from "../../src/cli/commands/plugin-add.ts";

let userDataRoot: string;
let pluginsRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const writePluginManifest = async (
  packageDir: string,
  manifest: { name: string; version: string; main?: string; landoPlugin?: Record<string, unknown> },
) => {
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      ...(manifest.main === undefined ? {} : { main: manifest.main }),
      landoPlugin: manifest.landoPlugin ?? {
        name: manifest.name,
        version: manifest.version,
        api: 4,
        entry: "index.js",
      },
    }),
  );
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n");
};

beforeEach(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-plugin-add-"));
  pluginsRoot = join(userDataRoot, "plugins");
});

afterEach(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
});

describe("meta:plugin:add command", () => {
  test("installs a plugin via the BunSelfRunner and validates the manifest before recording trust", async () => {
    const calls: Array<{ spec: string; cwd: string }> = [];
    const spawner = {
      install: async ({ spec, cwd }: { spec: string; cwd: string }) => {
        calls.push({ spec, cwd });
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-php"), {
          name: "@lando/plugin-php",
          version: "1.2.3",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-php") };
      },
    };
    const trustStore = new Set<string>();
    const result = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        spawner,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result.pluginName).toBe("@lando/plugin-php");
    expect(result.pluginVersion).toBe("1.2.3");
    expect(result.trusted).toBe(true);
    expect(result.trustSource).toBe("flag");
    expect(trustStore.has("@lando/plugin-php")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.cwd).toBe(pluginsRoot);
  });

  test("fails closed when the manifest cannot be validated", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        const packageDir = join(cwd, "node_modules", "@lando/plugin-bad");
        await mkdir(packageDir, { recursive: true });
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({ name: "@lando/plugin-bad", version: "0.0.1", landoPlugin: { name: "bad" } }),
        );
        return { exitCode: 0, stderr: "", packageRoot: packageDir };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-bad",
        trust: true,
        spawner,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
    }
  });

  test("rejects manifests whose entry escapes the package directory", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        const packageDir = join(cwd, "node_modules", "@lando/plugin-escape");
        await mkdir(packageDir, { recursive: true });
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({
            name: "@lando/plugin-escape",
            version: "0.0.1",
            landoPlugin: {
              name: "@lando/plugin-escape",
              version: "0.0.1",
              api: 4,
              entry: "../../../escape.js",
            },
          }),
        );
        return { exitCode: 0, stderr: "", packageRoot: packageDir };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-escape",
        trust: true,
        spawner,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
      expect(cause).toContain("entry");
    }
  });

  test("non-interactive run without --trust returns structured remediation", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-php"), {
          name: "@lando/plugin-php",
          version: "1.0.0",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-php") };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: false,
        nonInteractive: true,
        spawner,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("NotImplementedError");
      expect(cause).toContain("--trust");
    }
  });

  test("prompt-confirmed trust persists to the in-memory store for the current install session", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-prompt"), {
          name: "@lando/plugin-prompt",
          version: "0.1.0",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-prompt") };
      },
    };
    let promptCalls = 0;
    const prompter = {
      confirmTrust: async () => {
        promptCalls += 1;
        return true;
      },
    };
    const trustStore = new Set<string>();
    const first = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-prompt",
        spawner,
        prompter,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(first.trustSource).toBe("prompt");
    expect(promptCalls).toBe(1);
    expect(trustStore.has("@lando/plugin-prompt")).toBe(true);

    const second = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-prompt",
        spawner,
        prompter,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(second.trustSource).toBe("session");
    expect(promptCalls).toBe(1);
  });

  test("declining the prompt returns structured remediation", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-decline"), {
          name: "@lando/plugin-decline",
          version: "0.1.0",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-decline") };
      },
    };
    const prompter = { confirmTrust: async () => false };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-decline",
        spawner,
        prompter,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("declined");
    }
  });

  test("uses a fresh trust store per install", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-isolation"), {
          name: "@lando/plugin-isolation",
          version: "0.0.1",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-isolation") };
      },
    };
    let promptCalls = 0;
    const prompter = {
      confirmTrust: async () => {
        promptCalls += 1;
        return true;
      },
    };

    const altUserConfRoot = await mkdtemp(join(tmpdir(), "lando-trust-isolation-"));
    try {
      const result = await Effect.runPromise(
        pluginAdd({
          spec: "@lando/plugin-isolation",
          spawner,
          prompter,
          trustStore: new Set<string>(),
        }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );
      expect(result.trustSource).toBe("prompt");
      expect(promptCalls).toBe(1);
    } finally {
      await rm(altUserConfRoot, { recursive: true, force: true });
    }
  });
});
