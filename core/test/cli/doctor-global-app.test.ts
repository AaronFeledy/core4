import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";

import { FilePermissionError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem, GlobalAppService, PluginRegistry } from "@lando/sdk/services";

import { globalAppDoctor, renderGlobalAppDoctorResult } from "../../src/cli/commands/doctor-global-app.ts";

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
});
