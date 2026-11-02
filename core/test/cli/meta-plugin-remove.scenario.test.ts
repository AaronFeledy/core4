import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as HostContext from "@lando/engine/services/host-execution-context";

import { Cause, Effect, type Exit, Layer } from "effect";

import { FileIoError, PluginPackageOperationError, ProcessExecError } from "@lando/sdk/errors";
import { ConfigService, PluginTrustStore, ProcessRunner } from "@lando/sdk/services";
import { processRunnerFor } from "../_support/process-runner.ts";

import { makePluginTrustStore } from "@lando/engine/plugins/trust-store";
import { pluginAdd } from "../../src/cli/commands/plugin-add.ts";
import { pluginRemove, renderPluginRemoveResult } from "../../src/cli/commands/plugin-remove.ts";
import type { NpmPackument, NpmRegistryClient } from "../../src/recipes/npm-source.ts";
import type { TarballRecipeFetcher } from "../../src/recipes/tarball-source.ts";

let userDataRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.merge(
    Layer.succeed(
      ProcessRunner,
      processRunnerFor(() => Effect.succeed({ exitCode: 0 })),
    ),
    Layer.succeed(
      ConfigService,
      ConfigService.of({
        get: <K extends string>(key: K) =>
          Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
        getEffective: () => Effect.succeed({} as never),
      } as never),
    ),
  );

const pluginAddLayer = (dataRoot: string) =>
  Layer.merge(
    fakeConfigService(dataRoot),
    Layer.succeed(PluginTrustStore, makePluginTrustStore(join(dataRoot, "plugin-trust.yml"))),
  );

const makeNpmTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await mkdtemp(join(tmpdir(), "lando-plugin-remove-tar-"));
  const pkg = join(stage, "package");
  const out = join(stage, "archive.tgz");
  try {
    await mkdir(pkg, { recursive: true });
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(pkg, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, fileContent);
    }
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", out, "-C", stage, "package"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`tar failed: ${stderr}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

const sha512Sri = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const packumentFor = (packageName: string, bytes: Uint8Array, version = "1.2.3"): NpmPackument => ({
  "dist-tags": { latest: version },
  versions: {
    [version]: {
      dist: {
        tarball: `https://registry.example/${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`,
        integrity: sha512Sri(bytes),
      },
    },
  },
});

const clientFor = (packument: NpmPackument | undefined, calls?: Array<string>): NpmRegistryClient => ({
  fetchPackument: async (name) => {
    calls?.push(name);
    return packument;
  },
});

const fetcherFor = (bytes: Uint8Array, calls?: Array<string>): TarballRecipeFetcher => ({
  fetch: async (url) => {
    calls?.push(url);
    return bytes;
  },
});

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const readInstalledRegistry = async (): Promise<
  Record<string, { readonly path: string; readonly version: string }>
> =>
  JSON.parse(await readFile(join(userDataRoot, "plugins", "registry.json"), "utf8")) as Record<
    string,
    { readonly path: string; readonly version: string }
  >;

beforeEach(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-"));
});

afterEach(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
});

const failureError = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (exit._tag !== "Failure") throw new Error("expected failure");
  const found = Cause.findErrorOption(exit.cause);
  if (found._tag !== "Some") throw new Error(`expected tagged failure, got ${Cause.pretty(exit.cause)}`);
  return found.value;
};

describe("meta:plugin:remove command", () => {
  test("capture failure preserves installed bytes, registry, trust, and command cache", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "node_modules", "@lando/plugin-overflow");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), '{"name":"@lando/plugin-overflow"}');
    const registryPath = join(pluginsRoot, "registry.json");
    const registry = JSON.stringify({
      "@lando/plugin-overflow": { name: "@lando/plugin-overflow", version: "1.0.0", path: pluginDir },
    });
    await writeFile(registryPath, registry);
    const trustStore = new Set(["@lando/plugin-overflow"]);
    const cacheRoot = join(userDataRoot, "cache");
    const cache = join(cacheRoot, "apps", "tooling-overflow", "commands.bin");
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, "retained tooling cache");
    const result = await Effect.runPromise(
      pluginRemove({ name: "@lando/plugin-overflow", trustStore, cacheRoot }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor((input) => {
            expect(input.capture).toBe(true);
            expect(input.inheritStdin).toBeUndefined();
            expect(input.inheritOutput).toBeUndefined();
            return Effect.fail(
              new ProcessExecError({
                cmd: input.cmd,
                message: "Private capture exceeded its byte budget.",
                remediation: "Reduce output.",
              }),
            );
          }),
        ),
        Effect.provide(fakeConfigService(userDataRoot)),
        Effect.result,
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(await exists(pluginDir)).toBe(true);
    expect(await Bun.file(registryPath).text()).toBe(registry);
    expect(trustStore.has("@lando/plugin-overflow")).toBe(true);
    expect(await exists(cache)).toBe(true);
  });

  test("reports a no-op when the plugin is not installed", async () => {
    const result = await Effect.runPromise(
      pluginRemove({ name: "@lando/plugin-ghost" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result.removed).toBe(false);
    expect(renderPluginRemoveResult(result)).toContain("not-installed");
  });

  test("rejects path-traversal names before invoking removal or touching disk", async () => {
    const sentinel = join(userDataRoot, "DO_NOT_DELETE.txt");
    await writeFile(sentinel, "sentinel");

    let spawnerCalled = false;
    const runner = processRunnerFor(() =>
      Effect.sync(() => {
        spawnerCalled = true;
        return { exitCode: 0, stderr: "" };
      }),
    );
    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "../../../../etc" }).pipe(
        Effect.provideService(ProcessRunner, runner),
        Effect.provide(fakeConfigService(userDataRoot)),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(spawnerCalled).toBe(false);
    expect(await Bun.file(sentinel).text()).toBe("sentinel");
  });

  test("rejects npm-illegal characters (semicolons, slashes) in plugin names", async () => {
    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "@evil/../escape" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("rejects the reserved package.json name before removing the managed root manifest", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const manifestPath = join(pluginsRoot, "package.json");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(manifestPath, '{"name":"lando-plugin-root"}');

    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "package.json" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(manifestPath)).toBe(true);
    expect(await Bun.file(manifestPath).text()).toBe('{"name":"lando-plugin-root"}');
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("reserved");
      expect(cause).toContain("managed plugins root");
    }
  });

  test("rejects the reserved node_modules name before removing the shared tree", async () => {
    const sharedRoot = join(userDataRoot, "plugins", "node_modules");
    await mkdir(sharedRoot, { recursive: true });
    await writeFile(join(sharedRoot, "package.json"), '{"name":"lando-plugin-root"}');

    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "node_modules" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(sharedRoot)).toBe(true);
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("reserved");
      expect(cause).toContain("shared");
    }
  });

  test("rejects the reserved registry.json name before removing the managed registry", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(registryPath, '{"@lando/plugin-php":{"name":"@lando/plugin-php"}}');

    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "registry.json" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(registryPath)).toBe(true);
    expect(await Bun.file(registryPath).text()).toBe('{"@lando/plugin-php":{"name":"@lando/plugin-php"}}');
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("reserved");
      expect(cause).toContain("managed plugins root");
    }
  });

  test("removes an installed plugin and clears it from the trust store", async () => {
    const pluginDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);

    const trustStore = new Set<string>(["@lando/plugin-php"]);
    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result.removed).toBe(true);
    expect(trustStore.has("@lando/plugin-php")).toBe(false);
  });

  test("invalidates app tooling caches after removing a plugin", async () => {
    const pluginDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-cache-"));
    try {
      const toolingCacheDir = join(cacheRoot, "apps", "tooling-removefixture");
      await mkdir(toolingCacheDir, { recursive: true });
      await writeFile(join(toolingCacheDir, "commands.bin"), "stale tooling cache");

      await Effect.runPromise(
        pluginRemove({
          name: "@lando/plugin-php",
          cacheRoot,
        }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );

      expect(await Bun.file(join(toolingCacheDir, "commands.bin")).exists()).toBe(false);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("invalidates app tooling caches when reconciling a stale missing plugin", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({
        "@lando/plugin-php": {
          name: "@lando/plugin-php",
          version: "1.2.3",
          path: join(pluginsRoot, "@lando/plugin-php", "1.2.3"),
        },
      })}\n`,
    );
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-cache-"));
    try {
      const toolingCacheDir = join(cacheRoot, "apps", "tooling-stalefixture");
      await mkdir(toolingCacheDir, { recursive: true });
      await writeFile(join(toolingCacheDir, "commands.bin"), "stale tooling cache");

      const result = await Effect.runPromise(
        pluginRemove({ name: "@lando/plugin-php", cacheRoot }).pipe(
          Effect.provide(fakeConfigService(userDataRoot)),
        ),
      );

      expect(result.removed).toBe(false);
      expect(await Bun.file(join(toolingCacheDir, "commands.bin")).exists()).toBe(false);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("does not overwrite a corrupt installed registry during removal", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "@lando/plugin-php", "1.2.3");
    const registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(registryPath, "not json");

    const exit = await Effect.runPromiseExit(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(pluginDir)).toBe(false);
    expect(await Bun.file(registryPath).text()).toBe("not json");
  });

  test("reconciles a stale registry entry when plugin files are already gone", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify(
        {
          "@lando/plugin-php": {
            name: "@lando/plugin-php",
            version: "1.2.3",
            path: join(pluginsRoot, "@lando/plugin-php", "1.2.3"),
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.removed).toBe(false);
    expect(await readInstalledRegistry()).toEqual({});
  });

  test("retries cleanly after a failed uninstall leaves plugin files behind", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "node_modules", "@lando/plugin-php");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify(
        {
          "@lando/plugin-php": {
            name: "@lando/plugin-php",
            version: "1.2.3",
            path: pluginDir,
          },
        },
        null,
        2,
      )}\n`,
    );

    let attempts = 0;
    const runner = processRunnerFor(() =>
      Effect.sync(() => {
        attempts += 1;
        return attempts === 1
          ? { exitCode: 1, stderr: "injected uninstall failure" }
          : { exitCode: 0, stderr: "" };
      }),
    );

    const first = await Effect.runPromiseExit(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provideService(ProcessRunner, runner), Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(first._tag).toBe("Failure");
    expect(failureError(first)).toBeInstanceOf(PluginPackageOperationError);
    expect(await exists(pluginDir)).toBe(true);
    expect(await readInstalledRegistry()).toMatchObject({
      "@lando/plugin-php": { path: pluginDir, version: "1.2.3" },
    });

    const second = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provideService(ProcessRunner, runner), Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(second.removed).toBe(true);
    expect(await exists(pluginDir)).toBe(false);
    expect(await readInstalledRegistry()).toEqual({});
  });

  test("removes a default npm-installed plugin from the versioned directory", async () => {
    const bytes = await makeNpmTarball({
      "package.json": JSON.stringify({
        name: "@lando/plugin-php",
        version: "1.2.3",
        landoPlugin: {
          name: "@lando/plugin-php",
          version: "1.2.3",
          api: 4,
          entry: "index.js",
        },
      }),
      "index.js": "module.exports = {};\n",
    });
    const trustStore = new Set<string>();
    const installResult = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        registryClient: clientFor(packumentFor("@lando/plugin-php", bytes), []),
        fetcher: fetcherFor(bytes, []),
        trustStore,
      }).pipe(Effect.provide(pluginAddLayer(userDataRoot))),
    );
    const versionedDir = installResult.entry;
    expect(await exists(versionedDir)).toBe(true);
    expect(await readInstalledRegistry()).toMatchObject({
      "@lando/plugin-php": { path: versionedDir, version: "1.2.3" },
    });

    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.removed).toBe(true);
    expect(await exists(versionedDir)).toBe(false);
    expect(await readInstalledRegistry()).toEqual({});
    expect(trustStore.has("@lando/plugin-php")).toBe(false);
  });

  test("removes both layouts when both exist", async () => {
    const bytes = await makeNpmTarball({
      "package.json": JSON.stringify({
        name: "@lando/plugin-php",
        version: "1.2.3",
        landoPlugin: {
          name: "@lando/plugin-php",
          version: "1.2.3",
          api: 4,
          entry: "index.js",
        },
      }),
      "index.js": "module.exports = {};\n",
    });
    const trustStore = new Set<string>(["@lando/plugin-php"]);
    const installResult = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        registryClient: clientFor(packumentFor("@lando/plugin-php", bytes), []),
        fetcher: fetcherFor(bytes, []),
        trustStore,
      }).pipe(Effect.provide(pluginAddLayer(userDataRoot))),
    );
    const versionedDir = installResult.entry;
    const nodeModulesDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(nodeModulesDir, { recursive: true });
    await writeFile(join(nodeModulesDir, "package.json"), `{"name":"@lando/plugin-php"}`);

    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.removed).toBe(true);
    expect(await exists(versionedDir)).toBe(false);
    expect(await exists(nodeModulesDir)).toBe(false);
    expect(trustStore.has("@lando/plugin-php")).toBe(false);
  });

  test("fails before removing node_modules when the managed root manifest is corrupt", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "node_modules", "@lando/plugin-php");
    const manifestPath = join(pluginsRoot, "package.json");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(manifestPath, "not json");

    const exit = await Effect.runPromiseExit(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(pluginDir)).toBe(true);
    expect(await Bun.file(manifestPath).text()).toBe("not json");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("package.json");
      expect(cause).toContain("not readable JSON");
    }
  });

  test("updates the managed plugin root package manifest", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "node_modules", "@lando/plugin-php");
    const manifestPath = join(pluginsRoot, "package.json");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: "lando-plugin-root",
          private: true,
          dependencies: {
            "@lando/plugin-php": "1.2.3",
            "@lando/plugin-node": "2.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.removed).toBe(true);
    const updated = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(updated.dependencies).toEqual({ "@lando/plugin-node": "2.0.0" });
    expect(
      (await readdir(dirname(manifestPath))).filter((name) => /^package\.json\.tmp-/.test(name)),
    ).toEqual([]);
  });

  test("refuses to remove a versioned plugin spec referenced by the active Landofile", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-app-"));
    const pluginDir = join(userDataRoot, "plugins", "@lando/plugin-php", "1.2.3");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: versioned-plugin-ref-app", "plugins:", "  - @lando/plugin-php@1.2.3", "services: {}", ""].join(
        "\n",
      ),
    );

    try {
      const exit = await Effect.runPromiseExit(
        pluginRemove({
          name: "@lando/plugin-php",
          cwd: appRoot,
        }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );

      expect(exit._tag).toBe("Failure");
      expect(await exists(pluginDir)).toBe(true);
      if (exit._tag === "Failure") {
        const cause = JSON.stringify(exit.cause);
        expect(cause).toContain("active Landofile");
        expect(cause).toContain("versioned-plugin-ref-app");
      }
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  test("refuses to remove a plugin referenced by the active Landofile", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-app-"));
    const pluginDir = join(userDataRoot, "plugins", "@lando/plugin-php", "1.2.3");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: plugin-ref-app", "plugins:", "  - '@lando/plugin-php'", "services: {}", ""].join("\n"),
    );

    try {
      const exit = await Effect.runPromiseExit(
        pluginRemove({
          name: "@lando/plugin-php",
          cwd: appRoot,
        }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );

      expect(exit._tag).toBe("Failure");
      expect(await exists(pluginDir)).toBe(true);
      if (exit._tag === "Failure") {
        const cause = JSON.stringify(exit.cause);
        expect(cause).toContain("active Landofile");
        expect(cause).toContain("plugin-ref-app");
        expect(cause).toContain(".lando.yml");
      }
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  test("maps observed uninstall failure to its package stage and skips registry trust cache mutations", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "node_modules", "@lando/plugin-php");
    const versionedDir = join(pluginsRoot, "@lando/plugin-php", "1.2.3");
    await mkdir(pluginDir, { recursive: true });
    await mkdir(versionedDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(join(versionedDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    const registryPath = join(pluginsRoot, "registry.json");
    const registryBody = `${JSON.stringify({
      "@lando/plugin-php": {
        name: "@lando/plugin-php",
        version: "1.2.3",
        path: versionedDir,
      },
    })}\n`;
    await writeFile(registryPath, registryBody);
    const manifestPath = join(pluginsRoot, "package.json");
    const manifestBody = `${JSON.stringify({
      name: "lando-plugin-root",
      dependencies: { "@lando/plugin-php": "1.2.3" },
    })}\n`;
    await writeFile(manifestPath, manifestBody);
    const trustStore = new Set<string>(["@lando/plugin-php"]);
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-plugin-remove-fail-cache-"));
    try {
      const cachePath = join(cacheRoot, "apps", "tooling-failed-remove", "commands.bin");
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, "retained tooling cache");

      const exit = await Effect.runPromiseExit(
        pluginRemove({
          name: "@lando/plugin-php",
          trustStore,
          cacheRoot,
        }).pipe(
          Effect.provideService(
            ProcessRunner,
            processRunnerFor(() => Effect.succeed({ exitCode: 9, stderr: "bun remove failed" })),
          ),
          Effect.provide(fakeConfigService(userDataRoot)),
        ),
      );

      expect(exit._tag).toBe("Failure");
      const error = failureError(exit);
      expect(error).toBeInstanceOf(PluginPackageOperationError);
      expect(error).toMatchObject({
        _tag: "PluginPackageOperationError",
        operation: "remove",
        packageSpec: "@lando/plugin-php",
        commandId: "meta:plugin:remove",
        exitCode: 9,
        detail: "bun remove failed",
      });
      expect(await exists(pluginDir)).toBe(true);
      expect(await exists(versionedDir)).toBe(true);
      expect(await Bun.file(registryPath).text()).toBe(registryBody);
      expect(await Bun.file(manifestPath).text()).toBe(manifestBody);
      expect(trustStore.has("@lando/plugin-php")).toBe(true);
      expect(await exists(cachePath)).toBe(true);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  test("version-only layout removes without spawning bun", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const versionedDir = join(pluginsRoot, "@lando/plugin-php", "1.2.3");
    await mkdir(versionedDir, { recursive: true });
    await writeFile(join(versionedDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({
        "@lando/plugin-php": {
          name: "@lando/plugin-php",
          version: "1.2.3",
          path: versionedDir,
        },
      })}\n`,
    );
    let spawnerCalls = 0;

    const result = await Effect.runPromise(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor(() =>
            Effect.sync(() => {
              spawnerCalls += 1;
              return { exitCode: 0, stderr: "" };
            }),
          ),
        ),
        Effect.provide(fakeConfigService(userDataRoot)),
      ),
    );

    expect(result.removed).toBe(true);
    expect(spawnerCalls).toBe(0);
    expect(await exists(versionedDir)).toBe(false);
    expect(await readInstalledRegistry()).toEqual({});
  });

  test("preserves typed uninstall failures without inventing exitCode", async () => {
    const pluginDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);

    const typed = new ProcessExecError({
      message: "spawn failed",
      cmd: "bun",
      remediation: "fix bun",
    });
    const exitTyped = await Effect.runPromiseExit(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor(() => Effect.fail(typed)),
        ),
        Effect.provide(fakeConfigService(userDataRoot)),
      ),
    );
    expect(exitTyped._tag).toBe("Failure");
    expect(failureError(exitTyped)).toMatchObject({
      _tag: typed._tag,
      message: typed.message,
      cmd: typed.cmd,
    });
    expect(await exists(pluginDir)).toBe(true);

    const exitOpaque = await Effect.runPromiseExit(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor(() =>
            Effect.tryPromise({
              try: async () => {
                throw new Error("boom");
              },
              catch: (cause) =>
                new ProcessExecError({
                  cmd: "bun",
                  message: String(cause),
                  remediation: "Fix child execution.",
                }),
            }),
          ),
        ),
        Effect.provide(fakeConfigService(userDataRoot)),
      ),
    );
    expect(exitOpaque._tag).toBe("Failure");
    const opaque = failureError(exitOpaque);
    expect(opaque).toBeInstanceOf(ProcessExecError);
    expect(opaque).not.toHaveProperty("exitCode");
    expect(await exists(pluginDir)).toBe(true);
  });

  test("preserves FileIoError from injected uninstall", async () => {
    const pluginDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    const io = new FileIoError({
      message: "cannot read lock",
      path: pluginDir,
      remediation: "fix permissions",
    });
    const prepare = spyOn(HostContext, "prepareHostExecutionContext").mockRejectedValue(io);
    try {
      const exit = await Effect.runPromiseExit(
        pluginRemove({ name: "@lando/plugin-php" }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );
      expect(failureError(exit)).toMatchObject({
        _tag: io._tag,
        path: pluginDir,
        remediation: io.remediation,
      });
      expect(await exists(pluginDir)).toBe(true);
    } finally {
      prepare.mockRestore();
    }
  });
});
