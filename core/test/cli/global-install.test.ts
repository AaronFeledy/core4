import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Result, Schema } from "effect";

import { makeLandoPaths } from "@lando/core/paths";
import { AbsolutePath, LandofileShape, PluginManifest, ProviderId, ServiceName } from "@lando/core/schema";
import { PathsService, PluginRegistry, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { globalEnable } from "@lando/engine/operations/global-policy";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import { globalInstall } from "@lando/engine/operations/global-install";
import * as LandoConfigService from "@lando/engine/services/config";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { parseLandofile } from "@lando/landofile/parser";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { testStateStoreLayer } from "../_support/landofile-layer.ts";

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
    testStateStoreLayer,
    BunFileSystem.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    PrivateFileAccessService.layer,
    GlobalAppServiceLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([fakeManifest]),
        load: () => Effect.succeed(fakeManifest),
        loadServiceType: () => Effect.die("not needed"),
        loadServiceFeature: () => Effect.die("not needed"),
        loadAppFeature: () => Effect.die("not needed"),
      }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedPlansFor: () => Effect.succeed([]),
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
};

describe("global configuration reconciliation", () => {
  for (const authoredDist of [false, true]) {
    test(`rejected bundled configuration preserves authored files and diagnostics assets with ${authoredDist ? "an authored TypeScript dist" : "no dist"}`, async () => {
      await withTempRoots(async (dataRoot) => {
        const globalRoot = join(dataRoot, "global");
        const userPath = join(globalRoot, ".lando.yml");
        const distPath = join(globalRoot, ".lando.dist.ts");
        const userContent = "# Keep this invalid override unchanged.\nservices:\n  mailpit:\n    image: 42\n";
        const distContent = 'export default { name: "global", runtime: 4, services: {} };\n';
        const diagnosticRoot = join(globalRoot, "proxy-traefik", "diagnostic");
        const diagnosticFiles = [
          ["404.html", "Existing diagnostic page: preserve its bytes.\n"],
          ["nginx.conf", "# Existing diagnostic configuration: preserve its bytes.\n"],
        ] as const;
        await mkdir(globalRoot, { recursive: true });
        await writeFile(userPath, userContent);
        if (authoredDist) {
          await writeFile(distPath, distContent);
          await mkdir(diagnosticRoot, { recursive: true });
          for (const [name, content] of diagnosticFiles) await writeFile(join(diagnosticRoot, name), content);
        }

        const { contributions, result } = await Effect.runPromise(
          Effect.gen(function* () {
            const manifests = yield* (yield* PluginRegistry).list;
            const contributions = manifests.flatMap(
              (manifest) => manifest.contributes?.globalServices?.map(({ id }) => id) ?? [],
            );
            return { contributions, result: yield* globalInstall({}).pipe(Effect.result) };
          }).pipe(
            Effect.provide(makeLandoRuntime({ bootstrap: "global", plugins: { policy: "bundled-only" } })),
          ),
        );

        expect(contributions).toEqual(
          expect.arrayContaining(["mailpit", "ssh-agent", "traefik", "traefik-diagnostics"]),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          if (authoredDist) {
            expect(result.failure).toMatchObject({ _tag: "LandofileFormConflictError" });
          } else {
            expect(result.failure).toMatchObject({
              _tag: "LandofileWriteValidationError",
              issues: expect.arrayContaining([
                expect.objectContaining({
                  path: ["services", "mailpit", "image"],
                  source: expect.objectContaining({ file: userPath }),
                }),
              ]),
            });
          }
        }
        expect(await readFile(userPath, "utf8")).toBe(userContent);
        if (authoredDist) expect(await readFile(distPath, "utf8")).toBe(distContent);
        const dataEntries = await readdir(dataRoot, { recursive: true });
        const confEntries = await readdir(String(process.env.LANDO_USER_CONF_ROOT), { recursive: true });
        expect(dataEntries).not.toContain(join("global", ".lando.dist.yml"));
        const diagnosticEntries = [...dataEntries, ...confEntries].filter((path) =>
          /(?:^|[/\\])(404\.html|nginx\.conf)$/.test(path),
        );
        if (authoredDist) {
          expect(diagnosticEntries.sort()).toEqual(
            diagnosticFiles.map(([name]) => join("global", "proxy-traefik", "diagnostic", name)).sort(),
          );
          for (const [name, content] of diagnosticFiles) {
            expect(await readFile(join(diagnosticRoot, name), "utf8")).toBe(content);
          }
        } else {
          expect(dataEntries).not.toContain(join("global", "proxy-traefik", "diagnostic"));
          expect(diagnosticEntries).toEqual([]);
        }
      });
    });
  }

  test("materializes both global Landofile files with no plugin argument", async () => {
    await withTempRoots(async (dataRoot) => {
      const result = await Effect.runPromise(
        globalInstall({}).pipe(
          Effect.provide(makeLandoRuntime({ bootstrap: "global", plugins: { policy: "discovery" } })),
        ),
      );

      expect(result.paths.root).toBe(AbsolutePath.make(join(dataRoot, "global")));
      expect(result.dist.path).toBe(AbsolutePath.make(join(dataRoot, "global", ".lando.dist.yml")));
      expect(result.dist.status).toBe("created");
      expect(result.paths.userLandofile).toBe(AbsolutePath.make(join(dataRoot, "global", ".lando.yml")));
      expect(result.userLandofileCreated).toBe(true);
      const distContent = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      expect(distContent).toContain("name: global");
      expect(distContent).not.toContain("provider:");
      expect(result.dist.serviceIds).toContain("mailpit");
      expect(result.dist.serviceIds).toContain("traefik");
      expect(distContent).toContain("mailpit:");
      expect(distContent).toContain("docker.io/axllent/mailpit:v1.30.1");
      expect(distContent).toContain("traefik:");
      expect(distContent).toContain("traefik:v3.3");
      expect(await readFile(join(dataRoot, "global", ".lando.yml"), "utf8")).toContain("User overrides");
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
            [ServiceName.make("fakegs")]: { api: 4, type: "lando" },
          },
        });
      } finally {
        await rm(moduleRoot, { recursive: true, force: true });
      }
    });
  });

  test("enables an exact contribution id or owning plugin without starting services", async () => {
    await withTempRoots(async () => {
      const runtime = makeLandoRuntime({ bootstrap: "global", plugins: { policy: "discovery" } });
      for (const plugin of ["mailpit", "@lando/proxy-traefik"]) {
        const result = await Effect.runPromise(
          globalEnable({ selectors: [plugin] }).pipe(Effect.provide(runtime)),
        );
        expect(result.dist?.serviceIds).toContain(plugin === "mailpit" ? "mailpit" : "traefik");
      }
    });
  });

  test("selects the Docker host provider from configuration", async () => {
    await withTempRoots(async (dataRoot) => {
      await writeFile(
        join(String(process.env.LANDO_USER_CONF_ROOT), "config.yml"),
        "defaultProviderId: docker\n",
      );
      const selected: Array<string | undefined> = [];
      const dockerProvider = { ...TestRuntimeProvider, id: "docker" };
      const landoProvider = {
        ...TestRuntimeProvider,
        id: "lando",
        capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
      };
      const layer = Layer.mergeAll(
        testStateStoreLayer,
        BunFileSystem.layer,
        Layer.succeed(PathsService, makeLandoPaths()),
        PrivateFileAccessService.layer,
        GlobalAppServiceLayer.layer.pipe(
          Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
        ),
        Layer.succeed(
          PluginRegistry,
          PluginRegistry.of({
            list: Effect.succeed([]),
            load: () => Effect.die("not needed"),
            loadServiceType: () => Effect.die("not needed"),
            loadServiceFeature: () => Effect.die("not needed"),
            loadAppFeature: () => Effect.die("not needed"),
          }),
        ),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            appliedPlansFor: () => Effect.succeed([]),
            list: Effect.succeed([ProviderId.make("lando"), ProviderId.make("docker")]),
            capabilities: Effect.succeed(dockerProvider.capabilities),
            select: (plan) => {
              const id = typeof plan === "string" ? plan : plan?.provider;
              selected.push(id);
              return Effect.succeed(id === "lando" ? landoProvider : dockerProvider);
            },
          }),
        ),
      );

      await Effect.runPromise(
        globalInstall({}).pipe(Effect.provide(layer), Effect.provide(LandoConfigService.layer)),
      );

      expect(selected).toContain("docker");
      expect(selected).not.toContain(undefined);
      const dist = await readFile(join(dataRoot, "global", ".lando.dist.yml"), "utf8");
      expect(dist).not.toContain("provider:");
    });
  });
});
