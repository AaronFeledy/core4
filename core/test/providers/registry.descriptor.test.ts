import { describe, expect, test } from "bun:test";

import { Cause, type Context, DateTime, Effect, Layer, Schema } from "effect";

import { PluginDescriptorMismatchError, PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  PluginManifest,
  ProviderId,
} from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  ConfigService,
  Downloader,
  LogFileHelperAssets,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { makeRuntimeProviderRegistry } from "../../src/testing/engine-layers.ts";
import { makeLandoPaths } from "@lando/paths";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const fakeProviderId = ProviderId.make("descriptor-fake");
const fakeProvider = {
  ...TestRuntimeProvider,
  id: String(fakeProviderId),
  displayName: "Descriptor Fake Runtime Provider",
};

const manifestWithProvider = (name: string, providerId: ProviderId) =>
  Schema.decodeUnknownSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    contributes: { providers: [providerId] },
  });

const notRegistered = (id: string): PluginLoadError =>
  new PluginLoadError({ message: `not registered in descriptor registry test: ${id}`, pluginName: id });

const makeDependencyLayer = (manifests: ReadonlyArray<PluginManifest>) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ telemetry: { enabled: false } });
  const load = Effect.succeed(config);
  const configService: Context.Tag.Service<typeof ConfigService> = {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
  const pluginRegistry: Context.Tag.Service<typeof PluginRegistry> = {
    list: Effect.succeed(manifests),
    load: (name) => Effect.fail(notRegistered(name)),
    loadServiceType: (id) => Effect.fail(notRegistered(id)),
    loadServiceFeature: (id) => Effect.fail(notRegistered(id)),
    loadAppFeature: (id) => Effect.fail(notRegistered(id)),
  };
  const downloader = Effect.runSync(makeTestDownloader());
  const managedFiles = Effect.runSync(makeTestManagedFileStore());
  const stateStore = makeTestStateStore();

  return Layer.mergeAll(
    Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence: (plan) => plan }),
    Layer.succeed(ConfigService, configService),
    Layer.succeed(Downloader, downloader.service),
    Layer.succeed(LogFileHelperAssets, { payloads: Effect.succeed({}) }),
    Layer.succeed(ManagedFileService, managedFiles.service),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: "/tmp/descriptor-registry-test" })),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(StateStore, stateStore.service),
  );
};

const planFor = (provider: ProviderId): AppPlan => ({
  id: AppId.make("descriptor-registry-test"),
  name: "Descriptor Registry Test",
  slug: "descriptor-registry-test",
  root: AbsolutePath.make("/tmp/descriptor-registry-test/app"),
  provider,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
    source: "registry.descriptor.test",
    runtime: 4,
  },
  extensions: {},
});

const selectExit = (modules: ReadonlyArray<LandoPluginModule>, manifests: ReadonlyArray<PluginManifest>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* registry.select(planFor(fakeProviderId)).pipe(Effect.exit);
    }).pipe(
      Effect.provide(
        makeRuntimeProviderRegistry(modules).pipe(Layer.provide(makeDependencyLayer(manifests))),
      ),
    ),
  );

const selectEither = (modules: ReadonlyArray<LandoPluginModule>, manifests: ReadonlyArray<PluginManifest>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* registry.select(planFor(fakeProviderId)).pipe(Effect.either);
    }).pipe(
      Effect.provide(
        makeRuntimeProviderRegistry(modules).pipe(Layer.provide(makeDependencyLayer(manifests))),
      ),
    ),
  );

describe("RuntimeProviderRegistry descriptor lookup", () => {
  test("dies with PluginDescriptorMismatchError when a manifest provider has no descriptor", async () => {
    // Given: an installed plugin manifest whose module omits the declared provider descriptor.
    const manifest = manifestWithProvider("@example/missing-provider-descriptor", fakeProviderId);
    const module: LandoPluginModule = { name: manifest.name, manifest };

    // When: the declared provider is selected.
    const exit = await selectExit([module], [manifest]);

    // Then: the packaging invariant violation is a defect carrying the tagged mismatch error.
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const defect = Cause.dieOption(exit.cause);
      expect(defect._tag).toBe("Some");
      if (defect._tag === "Some" && defect.value instanceof PluginDescriptorMismatchError) {
        expect(defect.value._tag).toBe("PluginDescriptorMismatchError");
        expect(defect.value.remediation.length).toBeGreaterThan(0);
      } else {
        throw new Error("expected a PluginDescriptorMismatchError defect");
      }
    }
  });

  test("selects a runtime provider contributed by an injected fake module", async () => {
    // Given: an installed module contributing a provider unknown to core.
    const manifest = manifestWithProvider("@example/fake-runtime-provider", fakeProviderId);
    const module: LandoPluginModule = {
      name: manifest.name,
      manifest,
      runtimeProviders: new Map([
        [
          fakeProviderId,
          {
            id: fakeProviderId,
            make: () => Effect.succeed(fakeProvider),
          },
        ],
      ]),
    };

    // When: the contributed provider is selected through the registry.
    const result = await selectEither([module], [manifest]);

    // Then: the descriptor factory's provider shape is returned unchanged.
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toEqual(fakeProvider);
    }
  });
});
