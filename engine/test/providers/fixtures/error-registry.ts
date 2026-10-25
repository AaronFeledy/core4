import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, type RedactionServiceShape, makeRedactionService } from "@lando/redaction/service";
import { PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule, RuntimeProviderContribution } from "@lando/sdk/plugins";
import { AppPlan, GlobalConfig, PluginManifest, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  ConfigService,
  ContainerHelperAssets,
  Downloader,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeRuntimeProviderRegistry } from "../../../src/providers/registry.ts";
import { makeTestDownloader } from "../../../src/testing/downloader.ts";
import { makeTestStateStore } from "../../../src/testing/state-store.ts";

export const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "error-boundary",
  name: "error-boundary",
  slug: "error-boundary",
  root: "/tmp/error-boundary",
  provider: "test",
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
});
export const target = { app: plan.id, service: ServiceName.make("web") };
export const canary = "registry-error-canary-1294-unique";
export const errorFields = {
  providerId: "test",
  operation: "test",
  message: `failed ${canary}`,
  details: { nested: [canary, { text: canary }] },
  remediation: `retry ${canary}`,
};

interface RegistryOptions {
  readonly contribution?: Partial<RuntimeProviderContribution>;
  readonly redaction?: RedactionServiceShape;
}

export const registryLayer = (provider: RuntimeProviderShape, options: RegistryOptions = {}) => {
  const id = ProviderId.make(provider.id);
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@test/error-output",
    version: "1.0.0",
    api: 4,
    contributes: { providers: [id] },
  });
  const modules: readonly LandoPluginModule[] = [
    {
      name: manifest.name,
      manifest,
      runtimeProviders: new Map([
        [
          id,
          {
            id,
            appliedPlans: () => Effect.succeed([plan]),
            make: () => Effect.succeed(provider),
            ...options.contribution,
          },
        ],
      ]),
    },
  ];
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: id });
  const unsupported = (name: string) =>
    Effect.fail(new PluginLoadError({ message: "unused", pluginName: name }));
  const dependencies = Layer.mergeAll(
    Layer.succeed(ConfigService, { load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    Layer.succeed(PluginRegistry, {
      list: Effect.succeed([manifest]),
      load: unsupported,
      loadServiceType: unsupported,
      loadServiceFeature: unsupported,
      loadAppFeature: unsupported,
    }),
    Layer.succeed(Downloader, Effect.runSync(makeTestDownloader()).service),
    Layer.succeed(ContainerHelperAssets, { resolve: () => Effect.die("unused helper") }),
    Layer.succeed(ManagedFileService, Effect.runSync(makeTestManagedFileStore()).service),
    Layer.succeed(
      PathsService,
      makeLandoPaths({ userDataRoot: `/tmp/error-boundary-${crypto.randomUUID()}` }),
    ),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence: (value) => value }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)))),
    ),
  );
  const redaction = Layer.succeed(RedactionService, options.redaction ?? makeRedactionService());
  return makeRuntimeProviderRegistry(modules, {
    enforce: async () => undefined,
    verify: async () => undefined,
  }).pipe(Layer.provide(dependencies), Layer.provideMerge(redaction));
};
