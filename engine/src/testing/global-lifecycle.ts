import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProxyApplyError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  type PluginManifest,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  ConfigService,
  GlobalAppService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { FileSystem } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Schema } from "effect";
import { makeGlobalAppService } from "../global-app/service.ts";
import * as BunFileSystem from "../services/file-system.ts";
import { globalLifecyclePlan } from "./global-lifecycle-plan.ts";
import { makeTestStateStore } from "./state-store.ts";

export const makeGlobalLifecycleFixture = (
  directory: string,
  manifests: ReadonlyArray<PluginManifest> = [],
) => {
  const root = AbsolutePath.make(join(directory, "global"));
  const providerId = ProviderId.make("lando");
  const planFor = (names: ReadonlyArray<string>) => globalLifecyclePlan(root, names);
  const containers = new Map<string, ServiceRuntimeInfo>();
  const missingOverrides = new Map<string, Partial<ServiceRuntimeInfo>>();
  const removed: string[] = [];
  const published: string[][] = [];
  const planned: Array<Parameters<AppPlanner["Service"]["plan"]>[0]> = [];
  let applied: AppPlan | undefined;
  let consumers: ReadonlyArray<AppPlan> = [];
  let online = true;
  let failRoutes = false;
  let capabilities = TestRuntimeProvider.capabilities;
  const plans = () => [...(applied === undefined ? [] : [applied]), ...consumers];
  const inventory = (): ReadonlyArray<ServiceRuntimeInfo> => [
    ...Object.values(applied?.services ?? {}).map(
      (service): ServiceRuntimeInfo =>
        containers.get(service.name) ?? {
          app: AppId.make("global"),
          appRoot: root,
          providerId,
          service: service.name,
          status: "stopped",
          state: "stopped",
          publications: { status: "missing" },
          mounts: { status: "missing" },
          ...missingOverrides.get(service.name),
        },
    ),
    ...[...containers.values()].filter((row) => row.app !== AppId.make("global")),
  ];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    get capabilities() {
      return capabilities;
    },
    isAvailable: Effect.sync(() => online),
    getStatus: Effect.sync(() => ({ running: online })),
    appliedPlans: Effect.sync(plans),
    appliedStateInventory: Effect.sync(() => ({ plans: plans(), unreadable: [] })),
    list: () => Effect.sync(inventory),
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
      Effect.sync((): ServiceRuntimeInfo => {
        const observed = inventory().find((row) => row.app === target.app && row.service === target.service);
        if (observed !== undefined) return observed;
        const plan = plans().find((entry) => entry.id === target.app);
        return {
          app: target.app,
          service: target.service,
          providerId,
          ...(plan === undefined ? {} : { appRoot: plan.root }),
          status: "stopped",
          state: "stopped",
          publications: { status: "missing" },
          mounts: { status: "missing" },
        };
      }),
    removeObservedService: (row: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        const current = containers.get(row.service);
        if (current?.containerId !== row.containerId || current === undefined)
          return { kind: "absent" as const };
        containers.delete(row.service);
        removed.push(String(row.service));
        return { kind: "removed" as const };
      }),
    ensureReady: Effect.die("Policy operations must not initialize providers"),
    destroy: () => Effect.die("Selected cleanup must retain applied state and volumes"),
  };
  const registry = RuntimeProviderRegistry.of({
    list: Effect.succeed([providerId]),
    select: () => Effect.succeed(provider),
    capabilities: Effect.succeed(provider.capabilities),
    appliedStateInventory: () => provider.appliedStateInventory,
    appliedPlansFor: () => Effect.sync(plans),
    resolveAppliedPlan: () => Effect.sync(() => applied),
    resolveTeardownEvidence: () =>
      Effect.sync(() =>
        applied === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan: applied },
      ),
  });
  const config = Schema.decodeUnknownSync(GlobalConfig)({
    defaultProviderId: "lando",
    userDataRoot: directory,
  });
  const configService = ConfigService.of({
    load: Effect.succeed(config),
    get: (key) => Effect.succeed(config[key]),
  });
  const state = makeTestStateStore();
  const base = Layer.mergeAll(
    state.layer,
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(ConfigService, configService),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: directory,
        userConfRoot: join(directory, "conf"),
        userCacheRoot: join(directory, "cache"),
        systemPluginRoot: join(directory, "plugins"),
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed(manifests),
        declaredProviderCapabilities: () => provider.capabilities,
        load: () => Effect.die("unused plugin load"),
        loadServiceType: () => Effect.die("unused service-type load"),
        loadServiceFeature: () => Effect.die("unused feature load"),
        loadAppFeature: () => Effect.die("unused app-feature load"),
      }),
    ),
    Layer.succeed(RouterService, {
      ...makeTestRouterService(),
      applyRoutes: (routes, app) =>
        Effect.suspend(() => {
          if (failRoutes)
            return Effect.fail(
              new ProxyApplyError({
                message: "Router unavailable",
                app,
                proxyId: "test",
                remediation: "Retry route publication",
              }),
            );
          published.push(routes.map((route) => String(route.service)));
          return Effect.succeed({ app, appliedRoutes: routes, authorities: [] });
        }),
    }),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile) =>
          Effect.sync(() => {
            planned.push(landofile);
            return { ...planFor(Object.keys(landofile.document.services ?? {})), valueModel: 1 as const };
          }),
      }),
    ),
  );
  const global = Layer.effect(
    GlobalAppService,
    Effect.gen(function* () {
      return makeGlobalAppService(configService, yield* FileSystem);
    }),
  ).pipe(Layer.provide(base));
  const layer = Layer.merge(base, global);
  return {
    root,
    layer,
    state,
    provider,
    registry,
    containers,
    missingOverrides,
    removed,
    published,
    planned,
    planFor,
    inventory,
    setApplied: (plan: AppPlan) => {
      applied = plan;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
    setFailRoutes: (value: boolean) => {
      failRoutes = value;
    },
    setCapabilities: (value: typeof capabilities) => {
      capabilities = value;
    },
    setConsumers: (value: ReadonlyArray<AppPlan>) => {
      consumers = value;
    },
    startContainer: (plan: AppPlan, name: string) =>
      containers.set(name, {
        app: plan.id,
        appRoot: plan.root,
        providerId: plan.provider,
        service: ServiceName.make(name),
        containerId: `${plan.id}-${name}`,
        status: "running",
        state: "running",
        publications: { status: "present", bindings: [] },
        mounts: { status: "present", mounts: [] },
      }),
  };
};
