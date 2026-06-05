import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { pluginAdd } from "../../src/cli/commands/plugin-add.ts";
import { pluginRemove, renderPluginRemoveResult } from "../../src/cli/commands/plugin-remove.ts";
import type { NpmPackument, NpmRegistryClient } from "../../src/recipes/npm-source.ts";
import type { TarballRecipeFetcher } from "../../src/recipes/tarball-source.ts";

let userDataRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

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

describe("meta:plugin:remove command", () => {
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
    const spawner = {
      uninstall: async () => {
        spawnerCalled = true;
        return { exitCode: 0, stderr: "" };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginRemove({ name: "../../../../etc", spawner }).pipe(
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

  test("preserves plugin files when registry cleanup fails", async () => {
    const pluginsRoot = join(userDataRoot, "plugins");
    const pluginDir = join(pluginsRoot, "@lando/plugin-php", "1.2.3");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), `{"name":"@lando/plugin-php"}`);
    await writeFile(join(pluginsRoot, "registry.json"), "not json");

    const exit = await Effect.runPromiseExit(
      pluginRemove({
        name: "@lando/plugin-php",
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(pluginDir)).toBe(true);
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
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
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
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    const versionedDir = installResult.entry;
    const nodeModulesDir = join(userDataRoot, "plugins", "node_modules", "@lando/plugin-php");
    await mkdir(nodeModulesDir, { recursive: true });
    await writeFile(join(nodeModulesDir, "package.json"), `{"name":"@lando/plugin-php"}`);

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
    expect(await exists(versionedDir)).toBe(false);
    expect(await exists(nodeModulesDir)).toBe(false);
    expect(trustStore.has("@lando/plugin-php")).toBe(false);
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
        spawner: { uninstall: async () => ({ exitCode: 0, stderr: "" }) },
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.removed).toBe(true);
    const updated = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(updated.dependencies).toEqual({ "@lando/plugin-node": "2.0.0" });
    expect(await exists(`${manifestPath}.tmp`)).toBe(false);
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
});
