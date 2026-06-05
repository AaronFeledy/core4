import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { GlobalAppError } from "@lando/core/errors";
import { LandofileShape, PluginManifest, ProviderId } from "@lando/core/schema";
import { PluginRegistry, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

import { globalInstall, renderGlobalInstallResult } from "../../src/cli/commands/meta/global-install.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { parseLandofile } from "../../src/landofile/parser.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-install-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-install-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: environment cleanup must remove variables when originally unset.
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: environment cleanup must remove variables when originally unset.
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

const parseGeneratedLandofile = (content: string) =>
  Effect.runPromise(parseLandofile({ file: ".lando.dist.yml", content, cwd: "/tmp" }));

const layerWithFakeGlobalService = (modulePath: string) => {
  const fakeManifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-global-service",
    version: "1.0.0",
    api: 4,
    contributes: {
      globalServices: [{ id: "fakegs", module: modulePath, enabledByDefault: true }],
    },
  });
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
  };

  return Layer.mergeAll(
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
    Layer.succeed(PluginRegistry, {
      list: Effect.succeed([fakeManifest]),
      load: () => Effect.succeed(fakeManifest),
      loadServiceType: () => Effect.die("not needed"),
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make(provider.id)]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
};

describe("global:install command operation", () => {
  test("materializes both global Landofile files with no plugin argument", async () => {
    await withTempRoots(async (dataRoot) => {
      const result = await Effect.runPromise(
        globalInstall({}).pipe(
          Effect.provide(makeLandoRuntime({ bootstrap: "global", plugins: { policy: "discovery" } })),
        ),
      );
      const output = renderGlobalInstallResult(result);

      expect(result.paths.root).toBe(join(dataRoot, "global"));
      expect(result.dist.path).toBe(join(dataRoot, "global", ".lando.dist.yml"));
      expect(result.dist.status).toBe("created");
      expect(result.paths.userLandofile).toBe(join(dataRoot, "global", ".lando.yml"));
      expect(result.userLandofileCreated).toBe(true);
      const distContent = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      expect(distContent).toContain("name: global");
      expect(result.dist.serviceIds).toContain("mailpit");
      expect(result.dist.serviceIds).toContain("traefik");
      expect(distContent).toContain("mailpit:");
      expect(distContent).toContain("docker.io/axllent/mailpit:v1.30.1");
      expect(distContent).toContain("traefik:");
      expect(distContent).toContain("traefik:v3.3");
      expect(await readFile(join(dataRoot, "global", ".lando.yml"), "utf8")).toContain("User overrides");
      expect(output).toContain(".lando.dist.yml");
      expect(output).toContain("created");
      expect(output).toContain("Global services: mailpit, traefik");
    });
  });

  test("materializes plugin-contributed global services into the generated Landofile", async () => {
    await withTempRoots(async (dataRoot) => {
      const moduleRoot = await mkdtemp(join(process.cwd(), ".lando-global-service-module-"));
      try {
        const modulePath = join(moduleRoot, "fake-global-service.mjs");
        await writeFile(
          modulePath,
          'import { Effect } from "effect";\nexport default Effect.succeed({ api: 4, type: "lando" });\n',
        );

        const result = await Effect.runPromise(
          globalInstall({}).pipe(Effect.provide(layerWithFakeGlobalService(modulePath))),
        );
        const content = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
        const parsed = Schema.decodeUnknownSync(LandofileShape)(await parseGeneratedLandofile(content));

        expect(result.dist.serviceIds).toEqual(["fakegs"]);
        expect(content).toContain("fakegs:");
        expect(parsed).toEqual({
          name: "global",
          runtime: 4,
          services: {
            fakegs: { api: 4, type: "lando" },
          },
        });
      } finally {
        await rm(moduleRoot, { recursive: true, force: true });
      }
    });
  });

  test("rejects plugin argument with tagged remediation", async () => {
    await withTempRoots(async () => {
      const exit = await Effect.runPromiseExit(
        globalInstall({ plugin: "@lando/proxy-traefik" }).pipe(
          Effect.provide(makeLandoRuntime({ bootstrap: "global", plugins: { policy: "discovery" } })),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(GlobalAppError);
          if (failure.value instanceof GlobalAppError) {
            expect(failure.value.operation).toBe("install");
            expect(failure.value.remediation).toContain("lando global:install");
          }
        }
      }
    });
  });
});
