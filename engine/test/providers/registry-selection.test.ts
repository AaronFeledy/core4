import { expect, test } from "bun:test";
import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import { PluginLoadError } from "@lando/sdk/errors";
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
import { DateTime, Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeRuntimeProviderRegistry } from "../../src/providers/registry.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const requested = ProviderId.make("requested");
const plan: AppPlan = {
  id: AppId.make("selection"),
  name: "selection",
  slug: "selection",
  root: AbsolutePath.make("/tmp/selection"),
  provider: requested,
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
};

test.each([
  { target: requested, expected: "requested", kind: "explicit ID" },
  { target: plan, expected: "requested", kind: "real plan" },
  { target: undefined, expected: "configured-default", kind: "no argument" },
])("selects $expected with $kind", async ({ target, expected }) => {
  // Given: the configured default differs from the explicit target.
  const initialized: string[] = [];
  const modules: readonly LandoPluginModule[] = ["configured-default", "requested"].map((id) => {
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: `@example/${id}`,
      version: "1.0.0",
      api: 4,
      contributes: { providers: [id] },
    });
    const providerId = ProviderId.make(id);
    return {
      name: manifest.name,
      manifest,
      runtimeProviders: new Map([
        [
          providerId,
          {
            id: providerId,
            appliedPlans: () => Effect.die("selection must not load applied plans"),
            make: () =>
              Effect.sync(() => {
                initialized.push(id);
                return { ...TestRuntimeProvider, id };
              }),
          },
        ],
      ]),
    };
  });
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: "configured-default" });
  const unsupported = (name: string) =>
    Effect.fail(new PluginLoadError({ message: "unused", pluginName: name }));
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed(modules.map((module) => module.manifest)),
        load: unsupported,
        loadServiceType: unsupported,
        loadServiceFeature: unsupported,
        loadAppFeature: unsupported,
      }),
    ),
    Layer.succeed(Downloader, Effect.runSync(makeTestDownloader()).service),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)))),
    ),
    Layer.succeed(LogFileHelperAssets, LogFileHelperAssets.of({ payloads: Effect.succeed({}) })),
    Layer.succeed(ManagedFileService, Effect.runSync(makeTestManagedFileStore()).service),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: "/tmp/selection" })),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(AppPlanSanitizer, AppPlanSanitizer.of({ sanitizeForPersistence: (value) => value })),
  );
  // When
  const selected = await Effect.runPromise(
    Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select(target)).pipe(
      Effect.provide(
        makeRuntimeProviderRegistry(modules, {
          enforce: async () => undefined,
          verify: async () => undefined,
        }).pipe(Layer.provide(dependencies)),
      ),
    ),
  );
  // Then
  expect(selected.id).toBe(expected);
  expect(initialized).toEqual([expected]);
});
