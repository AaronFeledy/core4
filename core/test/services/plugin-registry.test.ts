import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Layer } from "effect";

import { PluginLoadError } from "@lando/core/errors";
import { ConfigService, Logger, PluginRegistry } from "@lando/core/services";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";

const EXPECTED_BUNDLED_PLUGIN_NAMES: ReadonlyArray<string> = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/provider-podman",
  "@lando/service-lando",
  "@lando/logger-pretty",
  "@lando/file-sync-mutagen",
  "@lando/proxy-traefik",
  "@lando/template-handlebars",
  "@lando/template-mustache",
];

let userDataRoot: string;
let appRoot: string;
let originalCwd: string;
let warnings: Array<string>;

const fakeConfigService = (dataRoot: string | undefined) =>
  Layer.succeed(ConfigService, {
    load: Effect.succeed(
      dataRoot === undefined
        ? ({ userConfRoot: "unused" } as never)
        : ({ userDataRoot: dataRoot, userConfRoot: join(dataRoot, "conf") } as never),
    ),
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
  });

const fakeLogger = (sink: Array<string>) =>
  Layer.succeed(Logger, {
    debug: () => Effect.void,
    info: () => Effect.void,
    warn: (message: string) =>
      Effect.sync(() => {
        sink.push(message);
      }),
    error: () => Effect.void,
  });

const pluginRegistryTestLayer = (dataRoot: string | undefined) =>
  PluginRegistryLive.pipe(Layer.provide(Layer.merge(fakeConfigService(dataRoot), fakeLogger(warnings))));

const runWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(pluginRegistryTestLayer(userDataRoot))));

const writeInstalledPlugin = async (
  pluginsRoot: string,
  plugin: { readonly name: string; readonly version: string; readonly description?: string },
) => {
  const packageRoot = join(pluginsRoot, plugin.name, plugin.version);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        landoPlugin: {
          name: plugin.name,
          version: plugin.version,
          api: 4,
          description: plugin.description,
          entry: "index.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(packageRoot, "index.js"), "export {};\n");
  await mkdir(pluginsRoot, { recursive: true });
  await writeFile(
    join(pluginsRoot, "registry.json"),
    `${JSON.stringify(
      {
        [plugin.name]: {
          name: plugin.name,
          version: plugin.version,
          path: packageRoot,
        },
      },
      null,
      2,
    )}\n`,
  );
};

beforeEach(async () => {
  originalCwd = process.cwd();
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-plugin-registry-user-"));
  appRoot = await mkdtemp(join(tmpdir(), "lando-plugin-registry-app-"));
  await writeFile(join(appRoot, ".lando.yml"), "name: plugin-registry-app\n");
  warnings = [];
  process.chdir(appRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(userDataRoot, { recursive: true, force: true });
  await rm(appRoot, { recursive: true, force: true });
});

describe("PluginRegistryLive", () => {
  test("lists bundled plugin manifests", async () => {
    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.map((manifest) => String(manifest.name))).toEqual([...EXPECTED_BUNDLED_PLUGIN_NAMES]);
  });

  test("loads the provider-lando bundled manifest", async () => {
    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@lando/provider-lando")),
    );

    expect(manifest).toMatchObject({
      name: "@lando/provider-lando",
      api: 4,
      contributes: { providers: ["lando"] },
    });
  });

  test("loads bundled service type contributions", async () => {
    const serviceType = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceType("node:lts")),
    );

    expect(serviceType.id).toBe("node:lts");
  });

  test("discovers user plugin registry entries from userDataRoot/plugins", async () => {
    await writeInstalledPlugin(join(userDataRoot, "plugins"), {
      name: "@example/user-plugin",
      version: "1.0.0",
      description: "user source",
    });

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/user-plugin")),
    );

    expect(manifest).toMatchObject({
      name: "@example/user-plugin",
      version: "1.0.0",
      description: "user source",
    });
  });

  test("discovers app plugin registry entries from cwd .lando/plugins", async () => {
    await writeInstalledPlugin(join(appRoot, ".lando", "plugins"), {
      name: "@example/app-plugin",
      version: "2.0.0",
      description: "app source",
    });

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.find((manifest) => manifest.name === "@example/app-plugin")).toMatchObject({
      version: "2.0.0",
      description: "app source",
    });
  });

  test("discovers app plugin registry entries when userDataRoot is undefined", async () => {
    await writeInstalledPlugin(join(appRoot, ".lando", "plugins"), {
      name: "@example/app-without-user-root-plugin",
      version: "2.2.0",
      description: "app source without user root",
    });

    const manifests = await Effect.runPromise(
      Effect.flatMap(PluginRegistry, (registry) => registry.list).pipe(
        Effect.provide(pluginRegistryTestLayer(undefined)),
      ),
    );

    expect(
      manifests.find((manifest) => manifest.name === "@example/app-without-user-root-plugin"),
    ).toMatchObject({
      version: "2.2.0",
      description: "app source without user root",
    });
  });

  test("discovers app plugin registry entries from the app root when cwd is nested", async () => {
    await writeInstalledPlugin(join(appRoot, ".lando", "plugins"), {
      name: "@example/nested-app-plugin",
      version: "2.1.0",
      description: "nested app source",
    });
    const nestedCwd = join(appRoot, "subdir", "deeper");
    await mkdir(nestedCwd, { recursive: true });
    process.chdir(nestedCwd);

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.find((manifest) => manifest.name === "@example/nested-app-plugin")).toMatchObject({
      version: "2.1.0",
      description: "nested app source",
    });
  });

  test("merges sources by app over user over system precedence and warns on conflicts", async () => {
    await writeInstalledPlugin(join(userDataRoot, "plugins"), {
      name: "@lando/provider-docker",
      version: "99.0.0",
      description: "user override",
    });
    await writeInstalledPlugin(join(appRoot, ".lando", "plugins"), {
      name: "@lando/provider-docker",
      version: "100.0.0",
      description: "app override",
    });

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@lando/provider-docker")),
    );

    expect(manifest).toMatchObject({
      version: "100.0.0",
      description: "app override",
    });
    expect(warnings).toEqual([
      "Plugin @lando/provider-docker from user source overrides system source.",
      "Plugin @lando/provider-docker from app source overrides user source.",
    ]);
  });

  test("fails with PluginLoadError for plugins outside the bundled registry", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("not-bundled")).pipe(
        Effect.provide(pluginRegistryTestLayer(userDataRoot)),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PluginLoadError);
        expect(failure.value.pluginName).toBe("not-bundled");
      }
    }
  });
});
