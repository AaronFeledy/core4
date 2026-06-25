import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer, Stream } from "effect";

import { FilePermissionError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { ConfigService, FileSystem, GlobalAppService, PluginRegistry } from "@lando/sdk/services";

import {
  DefaultGlobalAppDoctorLayer,
  globalAppDoctor,
  renderGlobalAppDoctorResult,
} from "../../src/cli/commands/doctor-global-app.ts";

const distLandofile = AbsolutePath.make("/tmp/lando-global/.lando.dist.yml");
const userLandofile = AbsolutePath.make("/tmp/lando-global/.lando.yml");

const globalAppLayer = Layer.succeed(GlobalAppService, {
  id: "global",
  root: Effect.succeed(AbsolutePath.make("/tmp/lando-global")),
  ensureRoot: Effect.void,
  paths: Effect.succeed({
    root: AbsolutePath.make("/tmp/lando-global"),
    distLandofile,
    userLandofile,
  }),
  ensureUserLandofile: Effect.succeed({ path: userLandofile, created: false }),
  regenerateDist: () => Effect.succeed({ path: distLandofile, status: "unchanged", serviceIds: [] }),
} satisfies typeof GlobalAppService.Service);

const pluginRegistryLayer = Layer.succeed(PluginRegistry, {
  list: Effect.succeed([]),
  load: () => Effect.die("unused"),
  loadServiceType: () => Effect.die("unused"),
  loadServiceFeature: () => Effect.die("unused"),
  loadAppFeature: () => Effect.die("unused"),
} satisfies typeof PluginRegistry.Service);

const unreadableFileSystemLayer = Layer.succeed(FileSystem, {
  read: () =>
    Stream.fail(new FilePermissionError({ message: "permission denied", path: String(distLandofile) })),
  readText: () =>
    Effect.fail(new FilePermissionError({ message: "permission denied", path: String(distLandofile) })),
  write: () => Effect.void,
  writeAtomic: () => Effect.void,
  exists: () => Effect.succeed(true),
  stat: () => Effect.succeed({ size: 10, mtimeMs: 0, isFile: true, isDirectory: false }),
  lstat: () => Effect.succeed({ size: 10, mtimeMs: 0, isFile: true, isDirectory: false }),
  mkdir: () => Effect.void,
  remove: () => Effect.void,
  readDir: () => Effect.succeed([]),
  readFile: () =>
    Effect.fail(new FilePermissionError({ message: "permission denied", path: String(distLandofile) })),
  writeFile: () => Effect.void,
} satisfies typeof FileSystem.Service);

const layer = Layer.mergeAll(globalAppLayer, pluginRegistryLayer, unreadableFileSystemLayer);

const writeInstalledPlugin = async (pluginsRoot: string, name: string) => {
  const packageRoot = join(pluginsRoot, name, "1.0.0");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        landoPlugin: {
          name,
          version: "1.0.0",
          api: 4,
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
        [name]: {
          name,
          version: "1.0.0",
          path: packageRoot,
        },
      },
      null,
      2,
    )}\n`,
  );
};

describe("global-app doctor check", () => {
  test("reports a failure when the dist Landofile exists but cannot be read", async () => {
    const result = await Effect.runPromise(globalAppDoctor().pipe(Effect.provide(layer)));
    const check = result.checks[0];

    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("error");
    expect(check?.context.installed).toBe("true");
    expect(check?.context.readError).toBe("permission denied");
    expect(check?.solutions[0]?.description).toContain("could not be read");

    const text = renderGlobalAppDoctorResult(result);
    expect(text).toContain("global-app: fail");
    expect(text).toContain("readError: permission denied");
  });

  test("DefaultGlobalAppDoctorLayer provides ConfigService to PluginRegistryLive", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-global-doctor-plugins-"));
    try {
      await writeInstalledPlugin(join(userDataRoot, "plugins"), "@example/global-doctor-user-plugin");
      const configLayer = Layer.succeed(ConfigService, {
        load: Effect.succeed({ userDataRoot } as never),
        get: (key) => Effect.succeed(key === "userDataRoot" ? (userDataRoot as never) : (undefined as never)),
      });
      const context = await Effect.runPromise(
        Effect.scoped(Layer.build(DefaultGlobalAppDoctorLayer.pipe(Layer.provide(configLayer)))),
      );
      const registry = Context.get(context, PluginRegistry);
      const manifests = await Effect.runPromise(registry.list);

      expect(manifests.map((manifest) => manifest.name)).toContain("@example/global-doctor-user-plugin");
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
