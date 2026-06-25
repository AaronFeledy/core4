import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Cause, Effect, Exit, Layer } from "effect";

import { PluginLoadError } from "@lando/core/errors";
import { ConfigService, Logger, PluginRegistry } from "@lando/core/services";
import { BUNDLED_PLUGINS } from "../../src/plugins/bundled.ts";
import { PluginRegistryLive, makePluginRegistryLive } from "../../src/plugins/registry.ts";
import {
  collectGlobalServiceContributions,
  defaultGlobalServiceModuleLoader,
} from "../../src/services/global-services.ts";

const EXPECTED_BUNDLED_PLUGIN_NAMES: ReadonlyArray<string> = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/provider-podman",
  "@lando/service-lando",
  "@lando/logger-pretty",
  "@lando/renderer-lando",
  "@lando/file-sync-mutagen",
  "@lando/proxy-traefik",
  "@lando/template-handlebars",
  "@lando/template-mustache",
];

const repoRoot = resolve(import.meta.dirname, "../../..");

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

const pluginRegistryTestLayerWithDiscovery = (
  dataRoot: string | undefined,
  discovery: Parameters<typeof makePluginRegistryLive>[0],
) =>
  makePluginRegistryLive(discovery).pipe(
    Layer.provide(Layer.merge(fakeConfigService(dataRoot), fakeLogger(warnings))),
  );

const runWithPluginRegistry = <A, E>(effect: Effect.Effect<A, E, PluginRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(pluginRegistryTestLayer(userDataRoot))));

const writeInstalledPluginRegistry = async (
  pluginsRoot: string,
  entries: ReadonlyArray<{ readonly name: string; readonly version: string; readonly path: string }>,
) => {
  await mkdir(pluginsRoot, { recursive: true });
  await writeFile(
    join(pluginsRoot, "registry.json"),
    `${JSON.stringify(
      Object.fromEntries(
        entries.map((entry) => [
          entry.name,
          {
            name: entry.name,
            version: entry.version,
            path: entry.path,
          },
        ]),
      ),
      null,
      2,
    )}\n`,
  );
};

const writeInstalledPluginPackage = async (
  pluginsRoot: string,
  plugin: {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly deprecated?: unknown;
  },
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
          deprecated: plugin.deprecated,
          entry: "index.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(packageRoot, "index.js"), "export {};\n");
  return packageRoot;
};

const writeInstalledPlugin = async (
  pluginsRoot: string,
  plugin: {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly deprecated?: unknown;
  },
) => {
  const packageRoot = await writeInstalledPluginPackage(pluginsRoot, plugin);
  await writeInstalledPluginRegistry(pluginsRoot, [{ ...plugin, path: packageRoot }]);
};

const writeExternalServiceTypePlugin = async (
  pluginsRoot: string,
  plugin: {
    readonly name: string;
    readonly version: string;
    readonly serviceTypes: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly extends?: string;
      readonly artifacts?: Readonly<Record<string, string>>;
    }>;
  },
) => {
  const packageRoot = join(pluginsRoot, plugin.name, plugin.version);
  await mkdir(packageRoot, { recursive: true });
  const effectModuleUrl = pathToFileURL(resolve(repoRoot, "node_modules/effect/dist/esm/index.js")).href;
  const entries = plugin.serviceTypes
    .map((serviceType) => {
      const extendsLine =
        serviceType.extends === undefined ? "" : `, extends: ${JSON.stringify(serviceType.extends)}`;
      const artifactsLine =
        serviceType.artifacts === undefined ? "" : `, artifacts: ${JSON.stringify(serviceType.artifacts)}`;
      return `  [${JSON.stringify(serviceType.id)}, { id: ${JSON.stringify(serviceType.id)}, name: ${JSON.stringify(serviceType.name)}, base: "lando"${extendsLine}${artifactsLine}, schema: Schema.Unknown, resolve: () => Effect.succeed({ base: "lando", normalizedConfig: {}, features: [] }) }],`;
    })
    .join("\n");
  await writeFile(
    join(packageRoot, "index.mjs"),
    `import { Effect, Schema } from ${JSON.stringify(effectModuleUrl)};\nexport const serviceTypes = new Map([\n${entries}\n]);\n`,
  );
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
          entry: "index.mjs",
          contributes: { serviceTypes: plugin.serviceTypes.map((serviceType) => serviceType.id) },
        },
      },
      null,
      2,
    )}\n`,
  );
  return packageRoot;
};

const writeInvalidInstalledPluginPackage = async (
  pluginsRoot: string,
  plugin: { readonly name: string; readonly version: string },
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
          api: 3,
        },
      },
      null,
      2,
    )}\n`,
  );
  return packageRoot;
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

  test("loads service type contributions from enabled bundled plugins when service-lando is disabled", async () => {
    const extraBundledPlugin = {
      name: "@example/extra-service-types",
      layer: Layer.empty,
      manifest: {
        name: "@example/extra-service-types",
        version: "1.0.0",
        api: 4,
        entry: "index.js",
        contributes: { serviceTypes: ["example:custom"] },
      },
      serviceTypes: new Map([
        [
          "example:custom",
          {
            id: "example:custom",
            __legacyToServicePlan: () => Effect.die("not needed"),
          },
        ],
      ]),
    } as never;
    (BUNDLED_PLUGINS as Array<typeof extraBundledPlugin>).push(extraBundledPlugin);
    try {
      const serviceType = await Effect.runPromise(
        Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceType("example:custom")).pipe(
          Effect.provide(
            pluginRegistryTestLayerWithDiscovery(userDataRoot, { disable: ["@lando/service-lando"] }),
          ),
        ),
      );

      expect(serviceType.id).toBe("example:custom");
    } finally {
      (BUNDLED_PLUGINS as Array<typeof extraBundledPlugin>).pop();
    }
  });

  test("loads an external (installed/linked) service type by id", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = await writeExternalServiceTypePlugin(userPluginsRoot, {
      name: "@example/external-service-types",
      version: "1.0.0",
      serviceTypes: [
        { id: "external-parent", name: "external-parent" },
        { id: "external-child", name: "external-child" },
      ],
    });
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/external-service-types", version: "1.0.0", path: packageRoot },
    ]);

    const serviceType = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceType("external-child")),
    );

    expect(serviceType.id).toBe("external-child");
    expect(warnings).toEqual([]);
  });

  test("resolves an external child service type that extends an external parent", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = await writeExternalServiceTypePlugin(userPluginsRoot, {
      name: "@example/external-extends-service-types",
      version: "1.0.0",
      serviceTypes: [
        { id: "external-parent", name: "external-parent", artifacts: { "from-parent": "parent.txt" } },
        {
          id: "external-child",
          name: "external-child",
          extends: "external-parent",
          artifacts: { "from-child": "child.txt" },
        },
      ],
    });
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/external-extends-service-types", version: "1.0.0", path: packageRoot },
    ]);

    const serviceType = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceType("external-child")),
    );

    expect(serviceType.id).toBe("external-child");
    expect(serviceType.artifacts).toEqual({ "from-parent": "parent.txt", "from-child": "child.txt" });
    expect(warnings).toEqual([]);
  });

  test("fails when an external service type id is not registered", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(PluginRegistry, (registry) => registry.loadServiceType("not-registered")).pipe(
        Effect.provide(pluginRegistryTestLayer(userDataRoot)),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PluginLoadError);
        expect(failure.value.message).toBe("Service type not-registered is not registered.");
      }
    }
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

  test("preserves deprecated notices from decoded installed plugin manifests", async () => {
    await writeInstalledPlugin(join(userDataRoot, "plugins"), {
      name: "@example/deprecated-plugin",
      version: "1.0.0",
      deprecated: {
        since: "4.2.0",
        severity: "warn",
        note: "Use @example/replacement-plugin.",
      },
    });

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/deprecated-plugin")),
    );

    expect(manifest.deprecated).toEqual({
      since: "4.2.0",
      severity: "warn",
      note: "Use @example/replacement-plugin.",
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

  test("keeps system and healthy plugins available when user discovery has an invalid manifest", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const brokenUserPackageRoot = await writeInvalidInstalledPluginPackage(userPluginsRoot, {
      name: "@example/broken-user-plugin",
      version: "1.0.0",
    });
    const healthyUserPackageRoot = await writeInstalledPluginPackage(userPluginsRoot, {
      name: "@example/healthy-user-plugin",
      version: "1.1.0",
      description: "healthy user source",
    });
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/broken-user-plugin", version: "1.0.0", path: brokenUserPackageRoot },
      { name: "@example/healthy-user-plugin", version: "1.1.0", path: healthyUserPackageRoot },
    ]);
    await writeInstalledPlugin(join(appRoot, ".lando", "plugins"), {
      name: "@example/healthy-app-plugin",
      version: "2.3.0",
      description: "healthy app source",
    });

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.map((manifest) => String(manifest.name))).toContain("@lando/provider-lando");
    expect(manifests.find((manifest) => manifest.name === "@example/broken-user-plugin")).toBeUndefined();
    expect(manifests.find((manifest) => manifest.name === "@example/healthy-user-plugin")).toMatchObject({
      version: "1.1.0",
      description: "healthy user source",
    });
    expect(manifests.find((manifest) => manifest.name === "@example/healthy-app-plugin")).toMatchObject({
      version: "2.3.0",
      description: "healthy app source",
    });
    expect(warnings).toEqual([
      expect.stringContaining("Plugin discovery from user source failed for @example/broken-user-plugin"),
    ]);
  });

  test("loads an external ESM plugin from a file URL package root and resolves package-root dependencies", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = join(userPluginsRoot, "@example", "esm-plugin", "1.0.0");
    await mkdir(join(packageRoot, "node_modules", "@example", "plugin-helper"), { recursive: true });
    await writeFile(
      join(packageRoot, "node_modules", "@example", "plugin-helper", "package.json"),
      `${JSON.stringify({ name: "@example/plugin-helper", type: "module", exports: "./index.mjs" }, null, 2)}\n`,
    );
    await writeFile(
      join(packageRoot, "node_modules", "@example", "plugin-helper", "index.mjs"),
      `export const marker = "from package root";\n`,
    );
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/esm-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/esm-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.mjs",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      `import { marker } from "@example/plugin-helper";\nif (marker !== "from package root") throw new Error("dependency not resolved from package root");\nexport const loaded = true;\n`,
    );
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/esm-plugin", version: "1.0.0", path: pathToFileURL(packageRoot).href },
    ]);

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/esm-plugin")),
    );

    expect(String(manifest.name)).toBe("@example/esm-plugin");
    expect(warnings).toEqual([]);
  });

  test("loads an external TypeScript plugin entry when Bun supports the file type", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = join(userPluginsRoot, "@example", "ts-plugin", "1.0.0");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/ts-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/ts-plugin",
            version: "1.0.0",
            api: 4,
            entry: "src/index.ts",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(packageRoot, "src", "index.ts"), `export const marker: string = "loaded";\n`);
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/ts-plugin", version: "1.0.0", path: packageRoot },
    ]);

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/ts-plugin")),
    );

    expect(String(manifest.name)).toBe("@example/ts-plugin");
    expect(warnings).toEqual([]);
  });

  test("rejects external plugin entries that escape the package root through symlinks", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const brokenRoot = join(userPluginsRoot, "@example", "symlink-entry-plugin", "1.0.0");
    const healthyRoot = await writeInstalledPluginPackage(userPluginsRoot, {
      name: "@example/healthy-user-plugin",
      version: "1.1.0",
      description: "healthy user source",
    });
    await mkdir(brokenRoot, { recursive: true });
    const outsideEntry = join(userPluginsRoot, "outside-entry.mjs");
    await writeFile(outsideEntry, "export {}\n");
    await symlink(outsideEntry, join(brokenRoot, "entry.mjs"));
    await writeFile(
      join(brokenRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/symlink-entry-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/symlink-entry-plugin",
            version: "1.0.0",
            api: 4,
            entry: "entry.mjs",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/symlink-entry-plugin", version: "1.0.0", path: brokenRoot },
      { name: "@example/healthy-user-plugin", version: "1.1.0", path: healthyRoot },
    ]);

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.find((manifest) => manifest.name === "@example/symlink-entry-plugin")).toBeUndefined();
    expect(manifests.find((manifest) => manifest.name === "@example/healthy-user-plugin")).toMatchObject({
      version: "1.1.0",
      description: "healthy user source",
    });
    expect(warnings).toEqual([expect.stringContaining("PluginLoadError")]);
    expect(warnings[0]).toContain("resolves through symlink outside the plugin package root");
  });

  test("normalizes accepted external contribution module paths so global-service loading resolves from the package root", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = join(userPluginsRoot, "@example", "global-plugin", "1.0.0");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    const effectModuleUrl = pathToFileURL(resolve(repoRoot, "node_modules/effect/dist/esm/index.js")).href;
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/global-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/global-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.js",
            contributes: {
              globalServices: [{ id: "external-mail", module: "./src/global-service.mjs" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(packageRoot, "index.js"), "export {};\n");
    await writeFile(
      join(packageRoot, "src", "global-service.mjs"),
      `import { Effect } from ${JSON.stringify(effectModuleUrl)};\nexport default Effect.succeed({ id: "external-mail", type: "node:lts" });\n`,
    );
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/global-plugin", version: "1.0.0", path: packageRoot },
    ]);

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/global-plugin")),
    );
    const [entry] = collectGlobalServiceContributions([manifest]);

    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.contribution.module).toBe(
      pathToFileURL(join(packageRoot, "src", "global-service.mjs")).href,
    );
    const service = await Effect.runPromise(defaultGlobalServiceModuleLoader.load(entry));
    expect(service).toMatchObject({ type: "node:lts" });
  });

  test("normalizes accepted external interaction-service module paths from the package root", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = join(userPluginsRoot, "@example", "interaction-plugin", "1.0.0");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/interaction-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/interaction-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.js",
            contributes: {
              interactionServices: [
                {
                  id: "fancy",
                  module: "./src/interaction.mjs",
                  capabilities: { interactive: true, promptTypes: ["text"], secretRedaction: true },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(packageRoot, "index.js"), "export {};\n");
    await writeFile(join(packageRoot, "src", "interaction.mjs"), "export {};\n");
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/interaction-plugin", version: "1.0.0", path: packageRoot },
    ]);

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/interaction-plugin")),
    );

    expect(manifest.contributes?.interactionServices?.[0]?.module).toBe(
      pathToFileURL(join(packageRoot, "src", "interaction.mjs")).href,
    );
  });

  test("normalizes accepted external remote-sync contribution module paths from the package root", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const packageRoot = join(userPluginsRoot, "@example", "remote-plugin", "1.0.0");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/remote-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/remote-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.js",
            contributes: {
              remoteSources: [
                {
                  id: "pantheon",
                  module: "./src/remote.mjs",
                  capabilities: {
                    environments: true,
                    push: true,
                    datasets: ["database"],
                  },
                },
              ],
              datasets: [{ id: "database", module: "./src/dataset.mjs", kind: "database" }],
              tunnelServices: [
                {
                  id: "quick",
                  module: "./src/tunnel.mjs",
                  capabilities: {
                    connectorBinary: true,
                    ephemeralUrls: true,
                    stableUrls: false,
                    basicAuth: true,
                    detached: true,
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(packageRoot, "index.js"), "export {};\n");
    await writeFile(join(packageRoot, "src", "remote.mjs"), "export {};\n");
    await writeFile(join(packageRoot, "src", "dataset.mjs"), "export {};\n");
    await writeFile(join(packageRoot, "src", "tunnel.mjs"), "export {};\n");
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/remote-plugin", version: "1.0.0", path: packageRoot },
    ]);

    const manifest = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.load("@example/remote-plugin")),
    );

    expect(manifest.contributes?.remoteSources?.[0]?.module).toBe(
      pathToFileURL(join(packageRoot, "src", "remote.mjs")).href,
    );
    expect(manifest.contributes?.datasets?.[0]?.module).toBe(
      pathToFileURL(join(packageRoot, "src", "dataset.mjs")).href,
    );
    expect(manifest.contributes?.tunnelServices?.[0]?.module).toBe(
      pathToFileURL(join(packageRoot, "src", "tunnel.mjs")).href,
    );
  });

  test("rejects external contribution modules outside the package root without blocking healthy plugins", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const brokenRoot = join(userPluginsRoot, "@example", "broken-module-plugin", "1.0.0");
    const healthyRoot = await writeInstalledPluginPackage(userPluginsRoot, {
      name: "@example/healthy-user-plugin",
      version: "1.1.0",
      description: "healthy user source",
    });
    await mkdir(brokenRoot, { recursive: true });
    await writeFile(join(userPluginsRoot, "outside.ts"), "export {};\n");
    await writeFile(
      join(brokenRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/broken-module-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/broken-module-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.js",
            contributes: {
              globalServices: [{ id: "escape", module: "../../../outside.ts" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(brokenRoot, "index.js"), "export {};\n");
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/broken-module-plugin", version: "1.0.0", path: brokenRoot },
      { name: "@example/healthy-user-plugin", version: "1.1.0", path: healthyRoot },
    ]);

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.find((manifest) => manifest.name === "@example/broken-module-plugin")).toBeUndefined();
    expect(manifests.find((manifest) => manifest.name === "@example/healthy-user-plugin")).toMatchObject({
      version: "1.1.0",
      description: "healthy user source",
    });
    expect(warnings).toEqual([expect.stringContaining("PluginLoadError")]);
    expect(warnings[0]).toContain("resolves outside the plugin package root");
  });

  test("rejects external interaction-service modules outside the package root", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const brokenRoot = join(userPluginsRoot, "@example", "broken-interaction-plugin", "1.0.0");
    const healthyRoot = await writeInstalledPluginPackage(userPluginsRoot, {
      name: "@example/healthy-user-plugin",
      version: "1.1.0",
      description: "healthy user source",
    });
    await mkdir(brokenRoot, { recursive: true });
    await writeFile(join(userPluginsRoot, "outside.ts"), "export {};\n");
    await writeFile(
      join(brokenRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/broken-interaction-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/broken-interaction-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.js",
            contributes: {
              interactionServices: [
                {
                  id: "escape",
                  module: "../../../outside.ts",
                  capabilities: { interactive: true, promptTypes: ["text"], secretRedaction: true },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(brokenRoot, "index.js"), "export {};\n");
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/broken-interaction-plugin", version: "1.0.0", path: brokenRoot },
      { name: "@example/healthy-user-plugin", version: "1.1.0", path: healthyRoot },
    ]);

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(
      manifests.find((manifest) => manifest.name === "@example/broken-interaction-plugin"),
    ).toBeUndefined();
    expect(manifests.find((manifest) => manifest.name === "@example/healthy-user-plugin")).toMatchObject({
      version: "1.1.0",
      description: "healthy user source",
    });
    expect(warnings).toEqual([expect.stringContaining("PluginLoadError")]);
    expect(warnings[0]).toContain("resolves outside the plugin package root");
  });

  test("rejects external contribution modules that escape the package root through symlinks", async () => {
    const userPluginsRoot = join(userDataRoot, "plugins");
    const brokenRoot = join(userPluginsRoot, "@example", "symlink-module-plugin", "1.0.0");
    const healthyRoot = await writeInstalledPluginPackage(userPluginsRoot, {
      name: "@example/healthy-user-plugin",
      version: "1.1.0",
      description: "healthy user source",
    });
    await mkdir(join(brokenRoot, "src"), { recursive: true });
    const outsideModule = join(userPluginsRoot, "outside-global-service.mjs");
    await writeFile(outsideModule, "export default {}\n");
    await symlink(outsideModule, join(brokenRoot, "src", "global-service.mjs"));
    await writeFile(
      join(brokenRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@example/symlink-module-plugin",
          version: "1.0.0",
          landoPlugin: {
            name: "@example/symlink-module-plugin",
            version: "1.0.0",
            api: 4,
            entry: "index.js",
            contributes: {
              globalServices: [{ id: "escape", module: "./src/global-service.mjs" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(brokenRoot, "index.js"), "export {};\n");
    await writeInstalledPluginRegistry(userPluginsRoot, [
      { name: "@example/symlink-module-plugin", version: "1.0.0", path: brokenRoot },
      { name: "@example/healthy-user-plugin", version: "1.1.0", path: healthyRoot },
    ]);

    const manifests = await runWithPluginRegistry(
      Effect.flatMap(PluginRegistry, (registry) => registry.list),
    );

    expect(manifests.find((manifest) => manifest.name === "@example/symlink-module-plugin")).toBeUndefined();
    expect(manifests.find((manifest) => manifest.name === "@example/healthy-user-plugin")).toMatchObject({
      version: "1.1.0",
      description: "healthy user source",
    });
    expect(warnings).toEqual([expect.stringContaining("PluginLoadError")]);
    expect(warnings[0]).toContain("resolves through symlink outside the plugin package root");
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
