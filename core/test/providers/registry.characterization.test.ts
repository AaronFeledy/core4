import { describe, expect, test } from "bun:test";
import "../../src/runtime/engine-composition.ts";

import { type Context, Effect, Layer, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { GlobalConfig, PluginManifest, ProviderId } from "@lando/sdk/schema";
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

import { RuntimeProviderRegistryLive } from "@lando/engine/providers/registry";
import { makeLandoPaths } from "@lando/paths";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const manifestWithProviders = (providers: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/registry-characterization-plugin",
    version: "1.0.0",
    api: 4,
    contributes: { providers },
  });

const notRegistered = (id: string): PluginLoadError =>
  new PluginLoadError({ message: `not wired for this characterization test: ${id}`, pluginName: id });

interface FakeRegistryOptions {
  readonly manifests: ReadonlyArray<PluginManifest>;
  readonly defaultProviderId?: string | null;
}

/** Builds the exact dependency set `RuntimeProviderRegistryLive` requires, fully faked. */
const buildDependencyLayer = (
  options: FakeRegistryOptions,
): Layer.Layer<
  | AppPlanSanitizer
  | ConfigService
  | PluginRegistry
  | Downloader
  | LogFileHelperAssets
  | ManagedFileService
  | PathsService
  | StateStore
> => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({
    telemetry: { enabled: false },
    ...(options.defaultProviderId === undefined ? {} : { defaultProviderId: options.defaultProviderId }),
  });
  const load = Effect.succeed(config);
  const configService: Context.Tag.Service<typeof ConfigService> = {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };

  const pluginRegistryService: Context.Tag.Service<typeof PluginRegistry> = {
    list: Effect.succeed(options.manifests),
    load: (name) => Effect.fail(notRegistered(name)),
    loadServiceType: (id) => Effect.fail(notRegistered(id)),
    loadServiceFeature: (id) => Effect.fail(notRegistered(id)),
    loadAppFeature: (id) => Effect.fail(notRegistered(id)),
  };

  const downloaderHandle = Effect.runSync(makeTestDownloader());
  const managedFileHandle = Effect.runSync(makeTestManagedFileStore());
  const stateStoreHandle = makeTestStateStore();
  const landoPaths = makeLandoPaths({ userDataRoot: "/tmp/registry-characterization" });

  return Layer.mergeAll(
    Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence: (plan) => plan }),
    Layer.succeed(ConfigService, configService),
    Layer.succeed(PluginRegistry, pluginRegistryService),
    Layer.succeed(Downloader, downloaderHandle.service),
    Layer.succeed(LogFileHelperAssets, { payloads: Effect.succeed({}) }),
    Layer.succeed(ManagedFileService, managedFileHandle.service),
    Layer.succeed(PathsService, landoPaths),
    Layer.succeed(StateStore, stateStoreHandle.service),
  );
};

const runList = (options: FakeRegistryOptions) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* registry.list;
    }).pipe(Effect.provide(RuntimeProviderRegistryLive.pipe(Layer.provide(buildDependencyLayer(options))))),
  );

const runSelectEither = (options: FakeRegistryOptions, providerId?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* registry
        .select(providerId === undefined ? undefined : ({ provider: ProviderId.make(providerId) } as never))
        .pipe(Effect.either);
    }).pipe(Effect.provide(RuntimeProviderRegistryLive.pipe(Layer.provide(buildDependencyLayer(options))))),
  );

/** Save/restore LANDO_PROVIDER around a test — registry.ts reads `process.env` directly (not injectable). */
const withEnvProvider = async <A>(value: string | undefined, fn: () => Promise<A>): Promise<A> => {
  const previous = process.env.LANDO_PROVIDER;
  if (value === undefined) process.env.LANDO_PROVIDER = undefined;
  else process.env.LANDO_PROVIDER = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) process.env.LANDO_PROVIDER = undefined;
    else process.env.LANDO_PROVIDER = previous;
  }
};

describe("RuntimeProviderRegistry.list (contract: ids derive from PluginRegistry manifests' contributes.providers)", () => {
  test("returns one ProviderId per plain-string provider contribution, across manifests, in encounter order", async () => {
    const manifests = [
      manifestWithProviders(["docker"]),
      manifestWithProviders(["custom-provider-a", "custom-provider-b"]),
    ];

    const ids = await runList({ manifests });

    expect(ids.map(String)).toEqual(["docker", "custom-provider-a", "custom-provider-b"]);
  });

  test("normalizes a deprecated {id, deprecated} contribution ref to its bare id string", async () => {
    const manifests = [manifestWithProviders(["docker", { id: "podman-legacy" }])];

    const ids = await runList({ manifests });

    expect(ids.map(String)).toEqual(["docker", "podman-legacy"]);
  });

  test("returns an empty list when no installed manifest contributes any provider", async () => {
    const manifests = [manifestWithProviders([])];

    const ids = await runList({ manifests });

    expect(ids).toEqual([]);
  });
});

describe("RuntimeProviderRegistry.select (contract: an uninstalled provider id fails with NoProviderInstalledError)", () => {
  test("fails with _tag NoProviderInstalledError and a message naming the requested id", async () => {
    const manifests = [manifestWithProviders(["docker"])];

    const result = await runSelectEither({ manifests }, "totally-unknown-provider");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("NoProviderInstalledError");
      expect(result.left.message).toBe("Runtime provider totally-unknown-provider is not installed.");
    }
  });

  test('fails the same way even for a provider id that LOOKS like a bundled provider ("docker") if it is not in the installed list', async () => {
    const manifests = [manifestWithProviders(["custom-provider-only"])];

    const result = await runSelectEither({ manifests }, "docker");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("NoProviderInstalledError");
      expect(result.left.message).toBe("Runtime provider docker is not installed.");
    }
  });
});

describe("RuntimeProviderRegistry.select(undefined) (contract: env > config > capability-default precedence)", () => {
  const manifests = [manifestWithProviders([])];

  test('falls back to the capability default ("lando") when neither LANDO_PROVIDER nor config defaultProviderId is set', async () => {
    await withEnvProvider(undefined, async () => {
      const result = await runSelectEither({ manifests, defaultProviderId: null });

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toBe("Runtime provider lando is not installed.");
      }
    });
  });

  test("prefers the config defaultProviderId over the capability default when LANDO_PROVIDER is unset", async () => {
    await withEnvProvider(undefined, async () => {
      const result = await runSelectEither({ manifests, defaultProviderId: "custom-config-provider" });

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toBe("Runtime provider custom-config-provider is not installed.");
      }
    });
  });

  test("prefers LANDO_PROVIDER over the configured default provider id", async () => {
    await withEnvProvider("custom-env-provider", async () => {
      const result = await runSelectEither({ manifests, defaultProviderId: "custom-config-provider" });

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toBe("Runtime provider custom-env-provider is not installed.");
      }
    });
  });
});
