import { join } from "node:path";
import { DateTime, Effect, Layer, Queue, Schema, Stream } from "effect";

import {
  AbsolutePath,
  type AppPlan,
  PluginManifest,
  PortablePath,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/core/schema";
import {
  type AppPlanner,
  type ApplyOptions,
  BuildOrchestrator,
  type CacheService,
  type ConfigService,
  EventService,
  type FileSystem,
  type GlobalAppService,
  type LandoEvent,
  PluginRegistry,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  SecretStore,
  type ServiceSelector,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import * as AppCacheService from "@lando/engine/cache/service";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import * as LandoConfigService from "@lando/engine/services/config";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { RedactionService } from "@lando/redaction/service";

import { testStateStoreLayer } from "./landofile-layer.ts";
import { makeLegacyServiceTypeFake } from "./legacy-service-type.ts";

export interface Harness {
  readonly dataRoot: string;
  readonly layer: Layer.Layer<
    | import("@lando/sdk/services").StateStore
    | import("@lando/sdk/services").EnvironmentValueResolver
    | AppPlanner
    | BuildOrchestrator
    | CacheService
    | ConfigService
    | EventService
    | FileSystem
    | GlobalAppService
    | PluginRegistry
    | RuntimeProviderRegistry,
    import("@lando/sdk/errors").ConfigError
  >;
  readonly applyCalls: Array<{
    readonly plan: AppPlan;
    readonly options: ApplyOptions;
    readonly environments: Readonly<Record<string, Readonly<Record<string, string>>>>;
  }>;
  readonly inspectCalls: Array<{ readonly target: ServiceSelector }>;
  readonly events: Array<LandoEvent>;
  readonly operations: Array<"build" | "apply">;
  readonly selectedProviders: string[];
}

const providerId = ProviderId.make("docker");
const fakeServiceType = makeLegacyServiceTypeFake({
  id: "lando",
  toServicePlan: ({
    name,
    service,
    appRoot,
    provider = ProviderId.make("lando"),
    primary = false,
    metadata,
  }) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "lando",
      provider,
      primary,
      artifact: { kind: "ref", ref: "lando-global-service:test" },
      environment: service.environment ?? {},
      workingDirectory: PortablePath.make("/app"),
      appMount: {
        source: AbsolutePath.make(appRoot),
        target: PortablePath.make("/app"),
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "passthrough",
      },
      mounts: [],
      storage: [],
      endpoints: [
        { _tag: "published", protocol: "http", port: 8080, name: "http", publication: { hostPort: 8080 } },
      ],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
});

export const makeHarness = async (
  dataRoot: string,
  moduleRoot: string,
  serviceIds: ReadonlyArray<string> = ["traefik"],
): Promise<Harness> => {
  const modulePath = join(moduleRoot, "fake-global-service.mjs");
  await Bun.write(
    modulePath,
    'import { Effect } from "effect";\nexport default Effect.succeed({ type: "lando", home: false });\n',
  );
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-global-ensure",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [fakeServiceType.id],
      globalServices: serviceIds.map((id) => ({ id, module: modulePath, enabledByDefault: true })),
    },
  });
  const applyCalls: Harness["applyCalls"] = [];
  const inspectCalls: Harness["inspectCalls"] = [];
  const events: Harness["events"] = [];
  const operations: Harness["operations"] = [];
  const selectedProviders: string[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: String(providerId),
    capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
    apply: (plan, options) =>
      Effect.gen(function* () {
        operations.push("apply");
        const resolve = options.resolveServiceEnvironment;
        const environments = Object.fromEntries(
          yield* Effect.forEach(Object.values(plan.services), (service) =>
            (resolve === undefined
              ? Effect.sync(() =>
                  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(service.environment),
                )
              : resolve(service)
            ).pipe(Effect.map((environment) => [service.name, environment] as const)),
          ),
        );
        applyCalls.push({ plan, options, environments });
        return { changed: true };
      }),
    inspect: (target) => {
      inspectCalls.push({ target });
      return Effect.succeed({
        app: target.app,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
        publications: {
          status: "present",
          bindings: [{ port: 8080, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
        },
      });
    },
  };
  const pluginRegistry = PluginRegistry.of({
    list: Effect.succeed([manifest]),
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.succeed(fakeServiceType),
    loadServiceFeature: (id: string) =>
      id === fakeServiceType.testFeature.id
        ? Effect.succeed(fakeServiceType.testFeature)
        : Effect.die(`unexpected service feature ${id}`),
    loadAppFeature: () => Effect.die("not used"),
  });
  const layer = Layer.mergeAll(
    testStateStoreLayer,
    LandoConfigService.layer,
    AppCacheService.layer,
    BunFileSystem.layer,
    GlobalAppServiceLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<LandoEvent>(),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedPlansFor: () => Effect.succeed([]),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(provider.capabilities),
        select: (plan) =>
          Effect.sync(() => {
            selectedProviders.push(typeof plan === "object" ? String(plan.provider) : (plan ?? "default"));
            return provider;
          }),
      }),
    ),
    Layer.succeed(
      SecretStore,
      SecretStore.of({
        id: "ensure-global-test",
        get: () => Effect.succeed("resolved-global-token"),
        has: () => Effect.succeed(true),
        list: Effect.succeed(["GLOBAL_TOKEN"]),
      }),
    ),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (plan) =>
          Effect.sync(() => {
            operations.push("build");
            return plan;
          }),
        buildApp: () => Effect.void,
      }),
    ),
    AppPlannerLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(PluginRegistry, pluginRegistry),
          AppCacheService.layer,
          LandoConfigService.layer,
        ),
      ),
    ),
  );
  const resolvedLayer = Layer.mergeAll(
    layer,
    EnvironmentValueResolverLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(layer, RedactionService.layer.pipe(Layer.provide(layer)))),
    ),
  );
  return { dataRoot, layer: resolvedLayer, applyCalls, inspectCalls, events, operations, selectedProviders };
};
