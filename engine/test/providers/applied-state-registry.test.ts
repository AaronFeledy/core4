import { expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema } from "effect";

import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import { PluginLoadError, ProviderUnavailableError } from "@lando/sdk/errors";
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

import { makeRuntimeProviderRegistry } from "../../src/providers/registry.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const root = AbsolutePath.make("/tmp/applied-state-registry/app");
const plan: AppPlan = {
  id: AppId.make("applied-owner"),
  name: "applied-owner",
  slug: "applied-owner",
  root,
  identity: { appRoot: root, ownerKey: "applied-owner-key" },
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.unsafeMake("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
};
const unavailable = (providerId: string, operation: string) =>
  new ProviderUnavailableError({
    providerId,
    operation,
    message: `${providerId} ${operation} unavailable`,
  });

const moduleFor = (
  id: string,
  inventory: Effect.Effect<ReadonlyArray<AppPlan>, ProviderUnavailableError>,
  initialize: Effect.Effect<void, ProviderUnavailableError>,
): LandoPluginModule => {
  const providerId = ProviderId.make(id);
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: `@example/${id}`,
    version: "1.0.0",
    api: 4,
    contributes: { providers: [id] },
  });
  const contribution = {
    id: providerId,
    appliedPlans: () => inventory,
    make: () => initialize.pipe(Effect.as({ ...TestRuntimeProvider, id, appliedPlans: inventory })),
  };
  return { name: manifest.name, manifest, runtimeProviders: new Map([[providerId, contribution]]) };
};

const run = (modules: ReadonlyArray<LandoPluginModule>) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: "podman" });
  const unsupported = (name: string) =>
    Effect.fail(new PluginLoadError({ message: "unused", pluginName: name }));
  const dependencies = Layer.mergeAll(
    Layer.succeed(ConfigService, { load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    Layer.succeed(PluginRegistry, {
      list: Effect.succeed(modules.map((module) => module.manifest)),
      load: unsupported,
      loadServiceType: unsupported,
      loadServiceFeature: unsupported,
      loadAppFeature: unsupported,
    }),
    Layer.succeed(Downloader, Effect.runSync(makeTestDownloader()).service),
    Layer.succeed(LogFileHelperAssets, { payloads: Effect.succeed({}) }),
    Layer.succeed(ManagedFileService, Effect.runSync(makeTestManagedFileStore()).service),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: "/tmp/applied-state-registry" })),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence: (value) => value }),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      if (registry.resolveAppliedPlan === undefined) return yield* Effect.die("missing resolver");
      const selected = yield* registry.resolveAppliedPlan(root);
      return selected === undefined
        ? undefined
        : {
            plan: selected,
            providerId: (yield* registry.select(selected)).id,
          };
    }).pipe(
      Effect.provide(
        makeRuntimeProviderRegistry(modules, {
          enforce: async () => undefined,
          verify: async () => undefined,
        }).pipe(Layer.provide(dependencies)),
      ),
      Effect.either,
    ),
  );
};

test("recovers the persisted owner when an unrelated provider cannot initialize", async () => {
  // Given: the default is Podman, but Lando owns the saved app; Podman has no saved claim.
  let unrelatedInitializations = 0;
  const modules = [
    moduleFor("lando", Effect.succeed([plan]), Effect.void),
    moduleFor(
      "podman",
      Effect.succeed([]),
      Effect.suspend(() => {
        unrelatedInitializations += 1;
        return Effect.fail(unavailable("podman", "select"));
      }),
    ),
  ];
  // When
  const result = await run(modules);
  // Then
  expect(result).toMatchObject({ _tag: "Right", right: { plan, providerId: "lando" } });
  expect(unrelatedInitializations).toBe(0);
});

test("propagates owner initialization failure after recovering its plan", async () => {
  // Given
  const failure = unavailable("lando", "select");
  // When
  const result = await run([moduleFor("lando", Effect.succeed([plan]), Effect.fail(failure))]);
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: failure });
});

test("propagates another provider's persisted inventory failure even with a matching owner", async () => {
  // Given
  const failure = unavailable("podman", "applied-state.list");
  // When
  const result = await run([
    moduleFor("lando", Effect.succeed([plan]), Effect.void),
    moduleFor("podman", Effect.fail(failure), Effect.fail(unavailable("podman", "select"))),
  ]);
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: failure });
});

test("rejects a mismatched supplier without initializing its runtime", async () => {
  // Given / When
  const result = await run([
    moduleFor("podman", Effect.succeed([plan]), Effect.fail(unavailable("podman", "select"))),
  ]);
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "AppResolveError", detail: "applied-state-provider" },
  });
});

test("rejects conflicting persisted root claims even when one runtime is unavailable", async () => {
  // Given / When
  const result = await run([
    moduleFor("lando", Effect.succeed([plan]), Effect.void),
    moduleFor(
      "podman",
      Effect.succeed([{ ...plan, provider: ProviderId.make("podman") }]),
      Effect.fail(unavailable("podman", "select")),
    ),
  ]);
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "AppResolveError", reason: "ambiguous" } });
});

test("still requires complete runtime evidence when no persisted owner exists", async () => {
  // Given
  const failure = unavailable("podman", "select");
  // When
  const result = await run([
    moduleFor("lando", Effect.succeed([]), Effect.void),
    moduleFor("podman", Effect.succeed([]), Effect.fail(failure)),
  ]);
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: failure });
});
