import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect";

import { publicationObservationFromInspect } from "@lando/container-runtime/podman/inspect";
import { invokeOperation } from "@lando/core/cli/operations";
import {
  GlobalAppError,
  GlobalDestroyConfirmationError,
  NoProviderInstalledError,
  ProviderUnavailableError,
  ProxyApplyError,
  ProxySetupError,
  RouterWatcherError,
  ServiceStartError,
} from "@lando/core/errors";
import { makeLandoPaths } from "@lando/core/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  PluginManifest,
  PluginName,
  PortablePath,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  ServicePlan,
  appIdentityKey,
} from "@lando/core/schema";
import {
  type AppPlanner,
  type AppSelector,
  type ApplyOptions,
  type BuildOptions,
  BuildOrchestrator,
  type CacheService,
  type ConfigService,
  type DestroyOptions,
  EventService,
  type FileSystem,
  GlobalAppService,
  type LandoEvent,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  SecretStore,
  type ServiceRuntimeInfo,
  type ServiceSelector,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import * as EnvironmentValueResolverLayer from "@lando/engine/services/environment-value-resolver";
import { RedactionService } from "@lando/redaction/service";
import { PreAppStartEvent } from "@lando/sdk/events";
import { makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { testStateStoreLayer } from "../_support/landofile-layer.ts";
import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";

import * as AppCacheService from "@lando/engine/cache/service";
import { readGlobalPolicy } from "@lando/engine/global-app/enablement";
import { withGlobalMutation } from "@lando/engine/global-app/mutation";
import { readGlobalReconciliation } from "@lando/engine/global-app/reconciliation";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import { loadGlobalPlan } from "@lando/engine/operations/global-plan";
import { globalDisable, globalEnable, globalReconcile } from "@lando/engine/operations/global-policy";
import { publishGlobalRoutes } from "@lando/engine/operations/global-routes";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { HostProviderOverride } from "@lando/engine/providers/host-provider";
import * as LandoConfigService from "@lando/engine/services/config";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { parseLandofile } from "@lando/landofile/parser";
import { globalConfigOptionsFromInput } from "../../src/cli/command-specs/meta/global/config.ts";
import { globalConfig } from "../../src/cli/commands/meta/global-config.ts";
import { globalDestroy, renderGlobalDestroyResult } from "../../src/cli/commands/meta/global-destroy.ts";
import { globalInfo } from "../../src/cli/commands/meta/global-info.ts";
import { globalList } from "../../src/cli/commands/meta/global-list.ts";
import { followGlobalLogs, globalLogs } from "../../src/cli/commands/meta/global-logs.ts";
import { GlobalRebuildResultSchema, globalRebuild } from "../../src/cli/commands/meta/global-rebuild.ts";
import { globalRestart } from "../../src/cli/commands/meta/global-restart.ts";
import { GlobalStartResultSchema, globalStart } from "../../src/cli/commands/meta/global-start.ts";
import { globalStatus } from "../../src/cli/commands/meta/global-status.ts";
import { globalStop, renderGlobalStopResult } from "../../src/cli/commands/meta/global-stop.ts";

interface ApplyCall {
  readonly environments: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly plan: AppPlan;
  readonly options: ApplyOptions;
}

interface DestroyCall {
  readonly target: AppSelector;
  readonly options: DestroyOptions;
}

interface InspectCall {
  readonly target: ServiceSelector;
}

interface ProviderCalls {
  readonly actions: Array<"apply" | "build">;
  readonly apply: Array<ApplyCall>;
  readonly build: Array<AppPlan>;
  readonly buildOptions: Array<BuildOptions | undefined>;
  readonly destroy: Array<DestroyCall>;
  readonly removed: string[];
  readonly inspect: Array<InspectCall>;
  readonly routes: Array<{ readonly app: string; readonly hostnames: ReadonlyArray<string> }>;
  readonly publishedRoutes: Array<{ readonly app: string; readonly hostnames: ReadonlyArray<string> }>;
  readonly routerSetups: number[];
  readonly routesRemoved: string[];
}

type HarnessLayer = Layer.Layer<
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
  | PathsService
  | PrivateFileAccessService
  | RouterService
  | RuntimeProviderRegistry
  | SecretStore,
  import("@lando/sdk/errors").ConfigError | import("@lando/sdk/errors").PluginManifestError
>;

interface HarnessOptions {
  readonly pluginName?: string;
  readonly pluginPresent?: boolean;
  readonly providerId?: ProviderId;
  readonly failDestroy?: boolean;
  readonly failRemove?: boolean;
  readonly failRemoveServices?: ReadonlyArray<string>;
  readonly missingAppliedState?: boolean;
  readonly incompleteObservationOwnership?: boolean;
  readonly observationProviderId?: ProviderId;
  readonly observationRoot?: AbsolutePath;
  readonly brokenModules?: ReadonlyArray<string>;
  readonly consumerPlans?: ReadonlyArray<AppPlan>;
  readonly consumerObservations?: ReadonlyArray<ServiceRuntimeInfo>;
  readonly unreadableConsumerState?: boolean;
  readonly beforeApply?: Effect.Effect<void>;
  readonly offline?: boolean;
  readonly vanishedServices?: ReadonlyArray<string>;
  readonly failInspect?: boolean;
  readonly exitedServices?: ReadonlyArray<string>;
  readonly completedServices?: ReadonlyArray<string>;
  readonly failRouterSetup?: boolean;
  readonly failRoutes?: boolean;
  readonly missingRouteObservation?: boolean;
  readonly failApply?: ReadonlyArray<string>;
  readonly serviceNames?: ReadonlyArray<string>;
  readonly serviceDependencies?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly unplannedServices?: ReadonlyArray<string>;
  readonly routerId?: string;
  readonly revalidateStartup?: Effect.Effect<void, RouterWatcherError>;
  readonly timeline?: Array<string>;
}

interface Harness {
  readonly dataRoot: string;
  readonly layer: HarnessLayer;
  readonly calls: ProviderCalls;
  readonly events: Array<LandoEvent>;
}

const artifactRefs = (plan: AppPlan): ReadonlyArray<string> =>
  Object.values(plan.services).flatMap((service) =>
    service.artifact?.kind === "ref" ? [service.artifact.ref] : [],
  );

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "lando-global-commands-data-"));
  const confRoot = await mkdtemp(join(tmpdir(), "lando-global-commands-conf-"));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    // biome-ignore lint/performance/noDelete: environment cleanup must preserve the originally unset state.
    if (previousData === undefined) delete process.env.LANDO_USER_DATA_ROOT;
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    // biome-ignore lint/performance/noDelete: environment cleanup must preserve the originally unset state.
    if (previousConf === undefined) delete process.env.LANDO_USER_CONF_ROOT;
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(dataRoot, { recursive: true, force: true });
    await rm(confRoot, { recursive: true, force: true });
  }
};

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
      mounts: [
        {
          type: "bind",
          source: AbsolutePath.make(appRoot),
          target: PortablePath.make("/app"),
          readOnly: false,
          excludes: [],
          includes: [],
          realization: "passthrough",
          role: "app",
        },
      ],
      endpoints: [
        { _tag: "published", protocol: "http", port: 8080, name: "http", publication: { hostPort: 8080 } },
      ],
      routes: [],
      dependsOn:
        name === "traefik"
          ? [{ service: "traefik-diagnostics", condition: "service_started", required: true }]
          : [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
});

const writeGlobalServiceModule = async (moduleRoot: string, router = false): Promise<string> => {
  const modulePath = join(moduleRoot, router ? "fake-router-global-service.mjs" : "fake-global-service.mjs");
  await writeFile(
    modulePath,
    `import { Effect } from "effect";\nexport default Effect.succeed({ api: 4, type: "lando", home: false${router ? ", routes: []" : ""} });\n`,
  );
  return modulePath;
};

const makeHarness = async (
  dataRoot: string,
  moduleRoot: string,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const modulePath = await writeGlobalServiceModule(moduleRoot);
  const routerModulePath = await writeGlobalServiceModule(moduleRoot, true);
  const brokenModulePath = join(moduleRoot, "broken-global-service.mjs");
  await writeFile(
    brokenModulePath,
    'import { Effect } from "effect"; export default Effect.fail("broken contribution");',
  );
  const dependencyModules = new Map<string, string>();
  for (const [id, dependencies] of Object.entries(options.serviceDependencies ?? {})) {
    const path = join(moduleRoot, `${id}-dependency-service.mjs`);
    await writeFile(
      path,
      `import { Effect } from "effect"; export default Effect.succeed(${JSON.stringify({ api: 4, type: "lando", home: false, dependsOn: dependencies.map((service) => ({ service, condition: "service_started", required: true })) })});`,
    );
    dependencyModules.set(id, path);
  }
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-global-command",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [fakeServiceType.id],
      globalServices: (options.serviceNames ?? ["proxy", "mail"]).map((id) => ({
        id,
        module: options.brokenModules?.includes(id)
          ? brokenModulePath
          : (dependencyModules.get(id) ??
            (id === "traefik" || id === "traefik-diagnostics" ? routerModulePath : modulePath)),
        enabledByDefault: true,
      })),
    },
  });
  const calls: ProviderCalls = {
    actions: [],
    apply: [],
    build: [],
    buildOptions: [],
    destroy: [],
    removed: [],
    inspect: [],
    routes: [],
    publishedRoutes: [],
    routerSetups: [],
    routesRemoved: [],
  };
  const events: Array<LandoEvent> = [];
  let appliedPlan: AppPlan | undefined;
  const runningServices = new Set<ServiceName>();
  const providerId = options.providerId ?? ProviderId.make("lando");
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: String(providerId),
    capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
    getStatus: Effect.sync(() => ({ running: !options.offline })),
    appliedPlans: Effect.sync(() =>
      options.missingAppliedState || appliedPlan === undefined ? [] : [appliedPlan],
    ),
    list: (filter) =>
      Effect.sync(() => {
        const plan = appliedPlan;
        const globalServices =
          plan === undefined
            ? []
            : [...runningServices, ...(options.unplannedServices ?? []).map((name) => ServiceName.make(name))]
                .filter((service) => !options.vanishedServices?.includes(service))
                .map((service) => ({
                  app: plan.id,
                  ...(options.incompleteObservationOwnership
                    ? {}
                    : { appRoot: options.observationRoot ?? plan.root }),
                  providerId: options.observationProviderId ?? providerId,
                  service,
                  containerId: `test-${service}`,
                  status: "running" as const,
                  state: "running",
                  publications: { status: "unknown" as const },
                }));
        return [...globalServices, ...(options.consumerObservations ?? [])].filter(
          (service) => filter.app === undefined || service.app === filter.app,
        );
      }),
    apply: (plan, applyOptions) =>
      Effect.gen(function* () {
        yield* options.beforeApply ?? Effect.void;
        calls.actions.push("apply");
        const resolve = applyOptions.resolveServiceEnvironment;
        const environments = Object.fromEntries(
          yield* Effect.forEach(Object.values(plan.services), (service) =>
            (resolve === undefined
              ? Effect.sync(() =>
                  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(service.environment),
                )
              : resolve(service)
            ).pipe(Effect.map((env) => [service.name, env] as const)),
          ),
        );
        calls.apply.push({ plan, options: applyOptions, environments });
        return { changed: true };
      }).pipe(
        Effect.flatMap((result) => {
          const failed = Object.values(plan.services).find((service) =>
            options.failApply?.includes(service.name),
          );
          return failed === undefined
            ? Effect.sync(() => {
                for (const service of Object.values(plan.services)) runningServices.add(service.name);
                appliedPlan = applyOptions.recordedPlan ?? {
                  ...plan,
                  services: { ...appliedPlan?.services, ...plan.services },
                };
                return result;
              })
            : Effect.fail(
                new ServiceStartError({
                  service: failed.name,
                  providerId: "lando",
                  operation: "apply",
                  message: `Unable to create ${failed.name}`,
                  remediation: "Repair the bind source.",
                }),
              );
        }),
      ),
    destroy: (target, destroyOptions) =>
      options.failDestroy
        ? Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "destroy",
              message: "provider unavailable",
              remediation: "Install or start the `lando` provider and confirm it can perform `destroy`.",
            }),
          )
        : Effect.sync(() => {
            calls.destroy.push({ target, options: destroyOptions });
            runningServices.clear();
            if (destroyOptions.removeState) appliedPlan = undefined;
            return { kind: "destroyed" as const };
          }),
    removeObservedService: (service) =>
      options.failRemove || options.failRemoveServices?.includes(String(service.service))
        ? Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "removeObservedService",
              message: "remove failed",
              remediation: "Restart provider.",
            }),
          )
        : Effect.sync(() => {
            calls.removed.push(String(service.service));
            runningServices.delete(service.service);
            return { kind: "removed" as const };
          }),
    inspect: (target) => {
      calls.inspect.push({ target });
      if (options.failInspect) {
        return Effect.fail(
          new ProviderUnavailableError({
            providerId: String(providerId),
            operation: "inspect",
            message: "provider unavailable",
            remediation:
              "Install or start the selected runtime provider and confirm it can perform `inspect`.",
          }),
        );
      }
      const exitCode = options.completedServices?.includes(String(target.service))
        ? 0
        : options.exitedServices?.includes(String(target.service))
          ? 17
          : undefined;
      return Effect.succeed({
        app: target.app,
        service: target.service,
        providerId,
        status: exitCode === undefined ? "running" : "stopped",
        state: exitCode === undefined ? "running" : "stopped",
        ...(exitCode === undefined ? {} : { exitCode }),
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
        publications: publicationObservationFromInspect({
          NetworkSettings: { Ports: { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "8443" }] } },
        }),
      });
    },
  };
  const currentManifest = () => ({
    ...manifest,
    name: options.pluginName === undefined ? manifest.name : PluginName.make(options.pluginName),
    contributes: {
      ...manifest.contributes,
      globalServices: (
        options.serviceNames ??
        manifest.contributes?.globalServices?.map((entry) => entry.id) ??
        []
      ).map((id) => {
        const previous = manifest.contributes?.globalServices?.find((entry) => entry.id === id);
        return {
          ...(previous ?? { id, enabledByDefault: true }),
          module: options.brokenModules?.includes(id) ? brokenModulePath : (previous?.module ?? modulePath),
        };
      }),
    },
  });
  const pluginRegistry = PluginRegistry.of({
    list: Effect.sync(() => (options.pluginPresent === false ? [] : [currentManifest()])),
    declaredProviderCapabilities: () => provider.capabilities,
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.succeed(fakeServiceType),
    loadServiceFeature: (id: string) =>
      id === fakeServiceType.testFeature.id
        ? Effect.succeed(fakeServiceType.testFeature)
        : Effect.die(`unexpected service feature ${id}`),
    loadAppFeature: () => Effect.die("not used"),
  });
  const buildOrchestrator = BuildOrchestrator.of({
    build: (plan: AppPlan, options?: BuildOptions) =>
      Effect.sync(() => {
        calls.actions.push("build");
        calls.build.push(plan);
        calls.buildOptions.push(options);
        return {
          ...plan,
          services: Object.fromEntries(
            Object.values(plan.services).map((service) => [
              service.name,
              { ...service, artifact: { kind: "ref" as const, ref: `built:${String(service.name)}` } },
            ]),
          ),
        };
      }),
    buildApp: () => Effect.void,
  });
  const layer = Layer.mergeAll(
    testStateStoreLayer,
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
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
            options.timeline?.push(event._tag);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<LandoEvent>(),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        id: options.routerId ?? "test",
        prepare: () => Effect.die("Global lifecycle must not prepare the router"),
        revalidateStartup: options.revalidateStartup ?? Effect.void,
        observeRoutes: (_app, routes) =>
          Effect.sync(() => {
            options.timeline?.push("routes-observed");
            const published = new Set(calls.routes.at(-1)?.hostnames ?? []);
            return {
              configuredAuthorities: routes.map((route) => ({
                hostname: route.hostname,
                scheme: "https" as const,
                port: 444,
              })),
              observation: options.missingRouteObservation
                ? { status: "missing" as const }
                : {
                    status: "present" as const,
                    publications: routes
                      .filter((route) => published.has(route.hostname))
                      .map((route) => ({
                        route,
                        authority: { hostname: route.hostname, scheme: "https" as const, port: 444 },
                      })),
                  },
            };
          }),
        setup: () =>
          Effect.sync(() => {
            calls.routerSetups.push(1);
          }).pipe(
            Effect.andThen(
              options.failRouterSetup
                ? Effect.fail(
                    new ProxySetupError({
                      proxyId: "traefik",
                      message: "router unavailable",
                      remediation: "Repair router.",
                    }),
                  )
                : Effect.void,
            ),
          ),
        applyRoutes: (routes, app) =>
          Effect.sync(() => {
            options.timeline?.push("routes-applied");
            calls.routes.push({ app: String(app), hostnames: routes.map((route) => route.hostname) });
            return {
              app,
              appliedRoutes: [...routes],
              authorities: routes.map((route) => ({
                scheme: "https" as const,
                hostname: route.hostname,
                port: 444,
              })),
            };
          }).pipe(
            Effect.andThen((result) =>
              options.failRoutes
                ? Effect.fail(
                    new ProxyApplyError({
                      proxyId: "test",
                      app: String(app),
                      message: "route publication failed",
                      remediation: "Retry route publication.",
                    }),
                  )
                : Effect.sync(() => {
                    calls.publishedRoutes.push({
                      app: String(app),
                      hostnames: routes.map((route) => route.hostname),
                    });
                    return result;
                  }),
            ),
          ),
        removeRoutes: (app) =>
          Effect.sync(() => {
            calls.routesRemoved.push(String(app));
            calls.publishedRoutes.push({ app: String(app), hostnames: [] });
          }),
      }),
    ),
    Layer.succeed(BuildOrchestrator, buildOrchestrator),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedStateInventory: () =>
          Effect.sync(() => ({
            plans: [
              ...(options.missingAppliedState || appliedPlan === undefined ? [] : [appliedPlan]),
              ...(options.consumerPlans ?? []),
            ],
            unreadable: options.unreadableConsumerState ? [{ path: "/protected/unreadable-app.json" }] : [],
          })),
        appliedPlansFor: () =>
          Effect.sync(() => (options.missingAppliedState || appliedPlan === undefined ? [] : [appliedPlan])),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
    Layer.succeed(
      SecretStore,
      SecretStore.of({
        id: "global-command-test",
        get: () => Effect.succeed("resolved-global-token"),
        has: () => Effect.succeed(true),
        list: Effect.succeed(["GLOBAL_TOKEN"]),
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
  return { dataRoot, layer: resolvedLayer, calls, events };
};

const authorGlobalSecretBindings = async (dataRoot: string, services: ReadonlyArray<string>) => {
  await mkdir(join(dataRoot, "global"), { recursive: true });
  await writeFile(
    join(dataRoot, "global", ".lando.local.yml"),
    `services:\n${services.map((name) => `  ${name}:\n    environment:\n      TOKEN: "\${secret:GLOBAL_TOKEN}"\n`).join("")}`,
  );
};

const withHarness = async <T>(
  run: (harness: Harness) => Promise<T>,
  options: HarnessOptions = {},
): Promise<T> =>
  withTempRoots(async (dataRoot) => {
    const moduleRoot = await mkdtemp(join(process.cwd(), ".lando-global-command-module-"));
    try {
      const harness = await makeHarness(dataRoot, moduleRoot, options);
      return await run(harness);
    } finally {
      await rm(moduleRoot, { recursive: true, force: true });
    }
  });

const registerConsumer = async (
  harness: Harness,
  options: { consumerPlans: AppPlan[]; consumerObservations: ServiceRuntimeInfo[] },
  kind: "user" | "scratch",
  required: ReadonlyArray<string>,
  routed = false,
) => {
  const base = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return (yield* registry.appliedPlansFor(AbsolutePath.make(join(harness.dataRoot, "global"))))[0];
    }).pipe(Effect.provide(harness.layer)),
  );
  const service = Object.values(base?.services ?? {})[0];
  if (base === undefined || service === undefined) throw new Error("Expected applied global fixture");
  const root = AbsolutePath.make(join(harness.dataRoot, `${kind}-consumer`));
  const id = AppId.make(`${kind}-consumer`);
  const consumer: AppPlan = {
    ...base,
    id,
    name: `${kind} consumer`,
    slug: String(id),
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    requires: { globalServices: required },
    routes: routed
      ? [
          {
            hostname: "consumer.global.test",
            scheme: "http",
            service: service.name,
            endpoint: 8080,
            priority: 2,
            backend: { service: service.name, protocol: "http", port: 8080 },
          },
        ]
      : [],
    extensions: kind === "scratch" ? { "@lando/core/scratch": { session: "test" } } : {},
  };
  options.consumerPlans.push(consumer);
  options.consumerObservations.push({
    app: id,
    appRoot: root,
    providerId: base.provider,
    service: service.name,
    containerId: `${id}-container`,
    status: "running",
    state: "running",
    publications: { status: "unknown" },
  });
  return consumer;
};

const materializeDist = (
  harness: Harness,
  services: Record<string, ServiceConfig> = { proxy: { type: "lando", home: false } },
) =>
  Effect.runPromise(
    Effect.flatMap(GlobalAppService, (globalApp) => globalApp.regenerateDist({ services })).pipe(
      Effect.provide(harness.layer),
    ),
  );

const distPath = (dataRoot: string): string => join(dataRoot, "global", ".lando.dist.yml");

const applyGlobalDist = async (
  harness: Harness,
  services: Record<string, ServiceConfig> = { proxy: { type: "lando", home: false } },
) => {
  await materializeDist(harness, services);
  const plan = await Effect.runPromise(
    Effect.gen(function* () {
      const loaded = yield* loadGlobalPlan();
      if (!loaded.materialized) throw new Error("expected global plan");
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(loaded.plan);
      yield* provider.apply(loaded.plan, { reconcile: false });
      return loaded.plan;
    }).pipe(Effect.scoped, Effect.provide(harness.layer)),
  );
  harness.calls.apply.length = 0;
  harness.calls.actions.length = 0;
  return plan;
};

const watcherRecordPath = (): string =>
  join(makeLandoPaths().globalAppRoot, "proxy-traefik", "watcher-diagnostic.json");

const writeWatcherRecord = async (observedAt: string): Promise<void> => {
  const path = watcherRecordPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      observedAt,
      providerId: "lando",
      watcherHost: "linux-host",
      failureClass: "inotify-limit",
      detail: "failed to create fsnotify watcher: too many open files",
    }),
  );
};

const failingWatcherObservation = (observedAt: string) =>
  Effect.promise(() => writeWatcherRecord(observedAt)).pipe(
    Effect.andThen(
      Effect.fail(
        new RouterWatcherError({
          message: "Router file-provider watcher failed.",
          proxyId: "traefik",
          failureClass: "inotify-limit",
          watcherHost: "linux-host",
          detail: "failed to create fsnotify watcher: too many open files",
          remediation: "Increase the host inotify limits and restart the global app.",
        }),
      ),
    ),
  );

const parseDist = async (path: string) => {
  const content = await readFile(path, "utf8");
  const parsed = await Effect.runPromise(parseLandofile({ file: path, content, cwd: join(path, "..") }));
  return Schema.decodeUnknownSync(LandofileShape)(parsed);
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some") throw new Error(Cause.pretty(exit.cause));
  expect(failure._tag).toBe("Some");
  return failure.value;
};

const independentGlobalServices = ["mailpit", "ssh-agent", "traefik", "traefik-diagnostics"];
const expectedGlobalGroups = [["mailpit"], ["ssh-agent"], ["traefik", "traefik-diagnostics"]];

const expectPartialFailure = (exit: Exit.Exit<unknown, unknown>, operation: "start" | "rebuild") => {
  const error = failureOf(exit);
  expect(error).toBeInstanceOf(GlobalAppError);
  if (!(error instanceof GlobalAppError)) throw new Error("expected partial global failure");
  expect(error.operation).toBe(operation);
  for (const name of independentGlobalServices) expect(error.message).toContain(name);
  expect(error.message).toContain("are running");
  expect(error.cause).toMatchObject({ _tag: "ServiceStartError", service: "ssh-agent" });
  expect(error.remediation).toBe("Repair the bind source.");
};

describe("meta:global command effects", () => {
  test.each(["start", "rebuild"] as const)(
    "%s observes routes after publication without treating apply as liveness",
    async (command) => {
      const timeline: string[] = [];
      await withHarness(
        async (harness) => {
          const result =
            command === "start"
              ? await Effect.runPromise(invokeOperation(globalStart()).pipe(Effect.provide(harness.layer)))
              : await Effect.runPromise(invokeOperation(globalRebuild()).pipe(Effect.provide(harness.layer)));
          if (!result.ok) throw result.error;
          const value = result.value;
          const rows =
            "servicesStarted" in value
              ? Schema.decodeUnknownSync(GlobalStartResultSchema)(value).servicesStarted
              : Schema.decodeUnknownSync(GlobalRebuildResultSchema)(value).servicesRebuilt;
          expect(harness.calls.routes).toHaveLength(1);
          expect(timeline).toContain("routes-observed");
          expect(timeline.indexOf("routes-applied")).toBeLessThan(timeline.indexOf("routes-observed"));
          expect(
            rows.flatMap((row) => row.connections).filter((connection) => connection.source === "route"),
          ).toEqual([
            expect.objectContaining({ host: "mail.global.lndo.site", state: "inactive" }),
            expect.objectContaining({ host: "proxy.global.lndo.site", state: "inactive" }),
          ]);
        },
        { missingRouteObservation: true, timeline },
      );
    },
  );
  test("starts and applies the global plan on the Docker host", async () => {
    await withHarness(
      async (harness) => {
        await Effect.runPromise(
          globalStart({}).pipe(
            Effect.provide(harness.layer),
            Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
          ),
        );
        expect(harness.calls.apply.length).toBeGreaterThan(0);
        expect(harness.calls.apply.every(({ plan }) => plan.provider === "docker")).toBe(true);
      },
      { providerId: ProviderId.make("docker") },
    );
  });
  test("changed host refuses apply while observation and teardown follow realized placement", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart({}).pipe(Effect.provide(harness.layer)));
      const before = harness.calls.apply.length;
      const result = await Effect.runPromise(
        globalStart({}).pipe(
          Effect.provide(harness.layer),
          Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
          Effect.result,
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "AppPlacementError",
          desiredProviderId: "docker",
          realizedProviderId: "lando",
        },
      });
      expect(harness.calls.apply).toHaveLength(before);
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* globalStatus({});
          yield* globalLogs({});
          yield* globalStop({});
          yield* globalDestroy({ yes: true });
        }).pipe(
          Effect.provide(harness.layer),
          Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
        ),
      );
      expect(harness.calls.destroy.at(-1)?.target.plan?.provider).toBe(ProviderId.make("lando"));
    });
  });
  test("restart refuses a placement mismatch before stopping the realized global app", async () => {
    await withHarness(async (harness) => {
      // Given: the global app is realized on lando.
      await Effect.runPromise(globalStart({}).pipe(Effect.provide(harness.layer)));
      const stopsBefore = harness.calls.destroy.length;
      // When: the host provider changed to docker.
      const result = await Effect.runPromise(
        globalRestart().pipe(
          Effect.provide(harness.layer),
          Effect.provideService(HostProviderOverride, ProviderId.make("docker")),
          Effect.result,
        ),
      );
      // Then: placement fails and nothing was torn down.
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AppPlacementError", realizedProviderId: "lando" },
      });
      expect(harness.calls.destroy).toHaveLength(stopsBefore);
      expect(harness.calls.routesRemoved).toEqual([]);
    });
  });
  test.each(["start", "rebuild", "restart"] as const)(
    "%s aggregates readiness failure without publishing routes",
    async (command) => {
      const revalidated: string[] = [];
      await withHarness(
        async (harness) => {
          const operation =
            command === "start"
              ? Effect.asVoid(globalStart())
              : command === "rebuild"
                ? Effect.asVoid(globalRebuild())
                : Effect.asVoid(globalRestart());
          const exit = await Effect.runPromiseExit(operation.pipe(Effect.provide(harness.layer)));
          const error = failureOf(exit);
          expect(error).toBeInstanceOf(GlobalAppError);
          if (!(error instanceof GlobalAppError)) throw new TypeError("Expected partial global failure");
          expect(error.message).toContain("mailpit failed");
          expect(error.cause).toMatchObject({
            _tag: "ServiceNotReadyError",
            service: "mailpit",
            exitCode: 17,
          });
          expect(harness.calls.routes).toEqual([]);
          expect(harness.calls.routesRemoved).toEqual(command === "restart" ? ["global"] : []);
          expect(harness.events.map((event) => event._tag)).not.toContain("post-global-start");
          expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
          expect(revalidated).toEqual(command === "start" ? [] : ["revalidated"]);
        },
        {
          serviceNames: independentGlobalServices,
          exitedServices: ["mailpit"],
          routerId: "traefik",
          revalidateStartup: Effect.sync(() => {
            revalidated.push("revalidated");
          }),
        },
      );
    },
  );

  test.each(["rebuild", "restart"] as const)(
    "%s revalidates when every readiness observation fails without replacing the failure",
    async (command) => {
      const revalidated: string[] = [];
      await withHarness(
        async (harness) => {
          const exit = await Effect.runPromiseExit(
            (command === "rebuild" ? Effect.asVoid(globalRebuild()) : Effect.asVoid(globalRestart())).pipe(
              Effect.provide(harness.layer),
            ),
          );
          expect(failureOf(exit)).toMatchObject({ _tag: "ServiceNotReadyError", reason: "inspect-failed" });
          expect(revalidated).toEqual(["revalidated"]);
        },
        {
          failInspect: true,
          routerId: "proxy",
          revalidateStartup: Effect.sync(() => {
            revalidated.push("revalidated");
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new RouterWatcherError({
                  message: "watcher still broken",
                  proxyId: "traefik",
                  failureClass: "inotify-limit",
                  watcherHost: "linux-host",
                  detail: "watcher failed",
                  remediation: "Repair watcher.",
                }),
              ),
            ),
          ),
        },
      );
    },
  );
  for (const command of ["stop", "destroy"] as const) {
    for (const overlay of [".lando.yml", ".lando.local.yml"] as const) {
      for (const invalid of [
        { kind: "schema", content: "services:\n  ssh-agent:\n    home: wrong\n" },
        { kind: "parse", content: "services:\n  broken line\n" },
      ]) {
        test(`${command} uses applied services despite malformed ${overlay} ${invalid.kind}`, async () => {
          await withHarness(async (harness) => {
            // Given applied state and an invalid authored overlay.
            const applied = await applyGlobalDist(harness);
            await writeFile(join(harness.dataRoot, "global", overlay), invalid.content);
            // When teardown runs without loading desired YAML.
            const result =
              command === "stop"
                ? await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)))
                : await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
            // Then the applied plan, policies, and route cleanup survive the invalid config.
            expect(result.materialized).toBe(true);
            expect(harness.calls.destroy).toHaveLength(1);
            expect(harness.calls.destroy[0]?.target.plan).toEqual(applied);
            expect(harness.calls.destroy[0]?.options).toEqual({
              volumes: false,
              removeState: command === "destroy",
            });
            expect(harness.calls.routesRemoved).toEqual(["global"]);
            expect(
              harness.events.filter((event) => !event._tag.startsWith("task.")).map((event) => event._tag),
            ).toEqual(
              command === "stop"
                ? ["pre-global-stop", "post-global-stop"]
                : ["pre-global-destroy", "post-global-destroy"],
            );
          });
        });
      }
    }
    test(`${command} does not mutate unstarted global services with invalid YAML`, async () => {
      await withHarness(async (harness) => {
        // Given authored materialization but no applied state or owned runtime resources.
        await materializeDist(harness);
        await writeFile(join(harness.dataRoot, "global", ".lando.yml"), "services: [\n");
        // When teardown resolves evidence.
        const result =
          command === "stop"
            ? await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)))
            : await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
        // Then stale routes are withdrawn without changing provider resources or lifecycle events.
        expect(result.materialized).toBe(true);
        expect(harness.calls.destroy).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual(["global"]);
        expect(harness.events).toEqual([]);
      });
    });
    test(`${command} removes applied services after authored services change`, async () => {
      await withHarness(async (harness) => {
        const applied = await applyGlobalDist(harness);
        await materializeDist(harness, { replacement: { type: "lando", home: false } });
        if (command === "stop") await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
        else await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
        expect(harness.calls.destroy[0]?.target.plan).toEqual(applied);
        expect(Object.keys(harness.calls.destroy[0]?.target.plan?.services ?? {})).toEqual(["proxy"]);
      });
    });
    test(`${command} tears down applied resources when the dist file is gone`, async () => {
      await withHarness(async (harness) => {
        const applied = await applyGlobalDist(harness);
        await rm(distPath(harness.dataRoot));
        const result =
          command === "stop"
            ? await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)))
            : await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
        expect(harness.calls.destroy[0]?.target.plan).toEqual(applied);
        expect(result.materialized).toBe(false);
        expect(harness.calls.routesRemoved).toEqual(["global"]);
        const rendered =
          "servicesStopped" in result ? renderGlobalStopResult(result) : renderGlobalDestroyResult(result);
        expect(rendered).toContain("proxy");
      });
    });
  }
  test("stop suppresses post-global-stop and route cleanup when applied teardown fails", async () => {
    await withHarness(
      async (harness) => {
        await applyGlobalDist(harness);
        await writeFile(join(harness.dataRoot, "global", ".lando.yml"), "services:\n  broken line\n");
        const exit = await Effect.runPromiseExit(globalStop().pipe(Effect.provide(harness.layer)));
        expect(failureOf(exit)).toMatchObject({ _tag: "ProviderUnavailableError", operation: "destroy" });
        expect(harness.events.map((event) => event._tag)).toEqual(["pre-global-stop"]);
        expect(harness.calls.routesRemoved).toEqual([]);
      },
      { failDestroy: true },
    );
  });
  test("start isolates ssh-agent failure without changing published routes", async () => {
    // Given three independent groups, one with an uncreatable ssh-agent.
    await withHarness(
      async (harness) => {
        // When global start attempts every group.
        const exit = await Effect.runPromiseExit(globalStart({}).pipe(Effect.provide(harness.layer)));

        // Then the router and mailpit remain running without changing the shared route definition.
        expectPartialFailure(exit, "start");
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
        expect(harness.calls.actions).toEqual(["build", "apply", "build", "apply", "build", "apply"]);
        expect([...new Set(harness.calls.inspect.map((call) => String(call.target.service)))].sort()).toEqual(
          ["mailpit", "traefik", "traefik-diagnostics"],
        );
        expect(harness.calls.routes).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
        expect(harness.calls.destroy).toEqual([]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-start");
        expect(harness.calls.apply.every(({ options }) => options.recordedPlan === undefined)).toBe(true);
      },
      { serviceNames: independentGlobalServices, failApply: ["ssh-agent"] },
    );
  });

  test("start keeps the partial error without retrying setup when the router group fails", async () => {
    // Given a routed mailpit and a router group that fails to start.
    await withHarness(
      async (harness) => {
        // When publication follows the group attempts without router setup.
        const exit = await Effect.runPromiseExit(globalStart({}).pipe(Effect.provide(harness.layer)));
        // Then the partial-start error remains primary and inspect is skipped.
        expect(failureOf(exit)).toMatchObject({
          _tag: "GlobalAppError",
          operation: "start",
          cause: { _tag: "ServiceStartError", service: "traefik" },
        });
        expect(harness.calls.routerSetups).toEqual([]);
        expect(harness.calls.routes).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
        expect([...new Set(harness.calls.inspect.map((call) => String(call.target.service)))].sort()).toEqual(
          ["mailpit", "ssh-agent"],
        );
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
      },
      { serviceNames: independentGlobalServices, failApply: ["traefik"], failRouterSetup: true },
    );
  });

  test("start preserves the first original error when every group fails", async () => {
    await withHarness(
      async (harness) => {
        // Given every group fails, when global start finishes all attempts.
        const exit = await Effect.runPromiseExit(globalStart({}).pipe(Effect.provide(harness.layer)));
        // Then the first typed failure retains its original diagnostic fields.
        expect(failureOf(exit)).toMatchObject({
          _tag: "ServiceStartError",
          service: "mailpit",
          message: "Unable to create mailpit",
          remediation: "Repair the bind source.",
        });
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
        expect(harness.calls.inspect).toEqual([]);
        expect(harness.calls.routes).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-start");
      },
      { serviceNames: independentGlobalServices, failApply: independentGlobalServices },
    );
  });

  test("all-failed selected start preserves published routes and the original error", async () => {
    // Given previously running services and a selected service that now fails to start.
    const failed: string[] = [];
    await withHarness(
      async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        failed.push("mail");
        harness.calls.routes.length = 0;
        // When the selected service fails while its owned sibling remains active.
        const exit = await Effect.runPromiseExit(
          globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        // Then the shared route definition and the original failure are preserved.
        expect(failureOf(exit)).toMatchObject({ _tag: "ServiceStartError", service: "mail" });
        expect(harness.calls.routes).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
      },
      { failApply: failed },
    );
  });

  test("all-failed rebuild preserves routes and the original error without revalidation", async () => {
    // Given a running global app whose replacement groups will all fail.
    const failed: string[] = [];
    const revalidated: string[] = [];
    await withHarness(
      async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        failed.push("mail", "proxy");
        harness.calls.routes.length = 0;
        // When rebuild destroys the old containers and cannot start replacements.
        const exit = await Effect.runPromiseExit(globalRebuild().pipe(Effect.provide(harness.layer)));
        // Then published routes are unchanged and the first failure remains primary.
        expect(failureOf(exit)).toMatchObject({ _tag: "ServiceStartError", service: "mail" });
        expect(harness.calls.routes).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
        expect(revalidated).toEqual([]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
      },
      {
        failApply: failed,
        routerId: "proxy",
        revalidateStartup: Effect.sync(() => {
          revalidated.push("router-revalidated");
        }),
      },
    );
  });

  for (const command of ["rebuild", "restart"] as const) {
    test(`${command} revalidates after publication failure and preserves ProxyApplyError`, async () => {
      // Given successful service groups but failing publication and router revalidation.
      const revalidated: string[] = [];
      await withHarness(
        async (harness) => {
          // When the global lifecycle command attempts publication.
          const exit =
            command === "rebuild"
              ? await Effect.runPromiseExit(globalRebuild().pipe(Effect.provide(harness.layer)))
              : await Effect.runPromiseExit(globalRestart().pipe(Effect.provide(harness.layer)));
          // Then revalidation still runs and cannot replace the publication error.
          expect(revalidated).toEqual(["router-revalidated"]);
          expect(failureOf(exit)).toMatchObject({
            _tag: "ProxyApplyError",
            message: "route publication failed",
          });
          expect(harness.calls.routes).toHaveLength(1);
          expect(harness.calls.routerSetups).toEqual([]);
          const eventTags = harness.events.map((event) => event._tag);
          expect(eventTags).not.toContain("post-global-start");
          expect(eventTags).not.toContain("post-global-rebuild");
        },
        {
          failRoutes: true,
          routerId: "proxy",
          revalidateStartup: Effect.sync(() => {
            revalidated.push("router-revalidated");
          }).pipe(Effect.andThen(failingWatcherObservation("2026-09-19T10:00:00.000Z"))),
        },
      );
    });
  }

  test("restart clears a stale router watcher record despite partial start failure", async () => {
    await withHarness(
      async (harness) => {
        // Given a stale watcher record and a broken independent ssh-agent.
        await writeWatcherRecord("2026-09-19T10:00:00.000Z");
        // When restart brings the router back despite the sidecar failure.
        const exit = await Effect.runPromiseExit(globalRestart().pipe(Effect.provide(harness.layer)));
        // Then router startup is refreshed and the partial-start failure survives.
        expectPartialFailure(exit, "start");
        expect(await Bun.file(watcherRecordPath()).exists()).toBe(false);
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
      },
      {
        serviceNames: independentGlobalServices,
        failApply: ["ssh-agent"],
        routerId: "traefik",
        revalidateStartup: Effect.promise(() => rm(watcherRecordPath())),
      },
    );
  });

  test("rebuild isolates ssh-agent failure and does not publish post-global-rebuild", async () => {
    const timeline: Array<string> = [];
    await withHarness(
      async (harness) => {
        // Given a failing ssh-agent and a router observation that also fails.
        // When rebuild recreates each independent group.
        const exit = await Effect.runPromiseExit(globalRebuild({}).pipe(Effect.provide(harness.layer)));
        // Then successful groups pass readiness and the first group error wins.
        expectPartialFailure(exit, "rebuild");
        expect(harness.calls.destroy).toHaveLength(1);
        expect(harness.calls.build.map((plan) => Object.keys(plan.services))).toEqual(expectedGlobalGroups);
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
        expect(harness.calls.apply.every(({ options }) => options.reconcile)).toBe(true);
        expect([...new Set(harness.calls.inspect.map((call) => String(call.target.service)))].sort()).toEqual(
          ["mailpit", "traefik", "traefik-diagnostics"],
        );
        expect(timeline).toContain("router-revalidated");
        expect(harness.calls.routerSetups).toEqual([]);
        expect(harness.calls.routes).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
        const recorded = harness.calls.apply[2]?.options.recordedPlan;
        if (recorded === undefined) throw new Error("expected full recorded plan");
        expect(artifactRefs(recorded)).toEqual(
          independentGlobalServices.map((name) =>
            name === "ssh-agent" ? "lando-global-service:test" : `built:${name}`,
          ),
        );
      },
      {
        serviceNames: independentGlobalServices,
        failApply: ["ssh-agent"],
        timeline,
        routerId: "traefik",
        revalidateStartup: Effect.sync(() => {
          timeline.push("router-revalidated");
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new RouterWatcherError({
                message: "watcher still broken",
                proxyId: "traefik",
                failureClass: "inotify-limit",
                watcherHost: "linux-host",
                detail: "watcher failed",
                remediation: "Repair watcher.",
              }),
            ),
          ),
        ),
      },
    );
  });

  test("start materializes the global app, applies the global-rooted plan, and inspects each service", async () => {
    await withHarness(async (harness) => {
      await authorGlobalSecretBindings(harness.dataRoot, ["mail", "proxy"]);
      const result = await Effect.runPromise(globalStart({}).pipe(Effect.provide(harness.layer)));

      expect(harness.calls.apply).toHaveLength(2);
      expect(harness.calls.build).toHaveLength(2);
      expect(harness.calls.buildOptions).toEqual([undefined, undefined]);
      expect(harness.calls.actions).toEqual(["build", "apply", "build", "apply"]);
      expect(String(harness.calls.apply[0]?.plan.id)).toBe("global");
      expect(harness.calls.apply[0]?.plan.name).toBe("global");
      expect(harness.calls.apply[0]?.plan.root).toBe(AbsolutePath.make(join(harness.dataRoot, "global")));
      expect(harness.calls.apply[0]?.options.reconcile).toBe(false);
      expect(harness.calls.apply[0]?.environments[ServiceName.make("mail")]).toMatchObject({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.environments[ServiceName.make("proxy")]).toMatchObject({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.plan.services[ServiceName.make("proxy")]?.environment).toEqual({
        LANDO_HOST_IP: "host.lando.internal",
        TOKEN: { _tag: "SecretRef", reference: "GLOBAL_TOKEN" },
      });
      expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual([
        ["mail"],
        ["proxy"],
      ]);
      expect(harness.calls.apply.every(({ options }) => options.recordedPlan === undefined)).toBe(true);
      expect(harness.calls.apply.flatMap(({ plan }) => artifactRefs(plan)).sort()).toEqual([
        "built:mail",
        "built:proxy",
      ]);
      expect([...new Set(harness.calls.inspect.map((call) => String(call.target.service)))].sort()).toEqual([
        "mail",
        "proxy",
      ]);
      expect(result.servicesStarted.map((service) => service.name).sort()).toEqual(["mail", "proxy"]);
    });
  });

  test("global start retains applied resources and suppresses its post event on readiness failure", async () => {
    await withHarness(
      async (harness) => {
        const exit = await Effect.runPromiseExit(globalStart({}).pipe(Effect.provide(harness.layer)));
        const error = failureOf(exit);
        expect(error).toBeInstanceOf(GlobalAppError);
        if (!(error instanceof GlobalAppError)) throw new TypeError("Expected partial failure");
        expect(error.message).toContain("mail failed to start; proxy is running");
        expect(error.cause).toMatchObject({
          _tag: "ServiceNotReadyError",
          service: "mail",
          reason: "not-running",
          exitCode: 17,
          providerId: "lando",
        });
        expect(harness.calls.apply).toHaveLength(2);
        expect(harness.calls.destroy).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-start");
      },
      { exitedServices: ["mail"] },
    );
  });

  test("start with --service applies and inspects only the selected subset", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(
        globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.apply).toHaveLength(1);
      expect(harness.calls.build).toHaveLength(1);
      expect(Object.keys(harness.calls.build[0]?.services ?? {})).toEqual(["mail"]);
      expect(harness.calls.actions).toEqual(["build", "apply"]);
      expect(Object.keys(harness.calls.apply[0]?.plan.services ?? {})).toEqual(["mail"]);
      expect(harness.calls.apply.flatMap(({ plan }) => artifactRefs(plan))).toEqual(["built:mail"]);
      expect([...new Set(harness.calls.inspect.map((call) => String(call.target.service)))]).toEqual([
        "mail",
      ]);
      expect(result.servicesStarted.map((service) => service.name)).toEqual(["mail"]);
    });
  });

  test("starting one routed global service excludes stopped siblings and reports its advertised URL", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        mail: {
          type: "lando",
        },
        proxy: { type: "lando" },
      });
      const result = await Effect.runPromise(
        globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(Object.keys(harness.calls.apply[0]?.plan.services ?? {})).toEqual(["mail"]);
      expect(harness.calls.routerSetups).toEqual([]);
      expect(harness.calls.routes).toEqual([{ app: "global", hostnames: ["mail.global.lndo.site"] }]);
      expect(result.servicesStarted[0]?.connections).toContainEqual(
        expect.objectContaining({
          source: "route",
          binding: "assigned",
          state: "active",
          url: "https://mail.global.lndo.site:444",
        }),
      );
    });
  });

  test.each(["start", "rebuild"] as const)(
    "%s retains configured connections as inactive for completed global jobs",
    async (command) => {
      await withHarness(
        async (harness) => {
          // Given a routed job whose successful completion gates the running proxy.
          await materializeDist(harness);
          await writeFile(
            join(harness.dataRoot, "global", ".lando.yml"),
            "services:\n  proxy:\n    dependsOn:\n      - service: mail\n        condition: service_completed_successfully\n",
          );
          // When the real global operation applies, waits, and decorates its result.
          const rows =
            command === "start"
              ? (await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)))).servicesStarted
              : (await Effect.runPromise(globalRebuild().pipe(Effect.provide(harness.layer))))
                  .servicesRebuilt;
          // Then configured addresses survive completion but cannot be active.
          expect(harness.calls.routes.flatMap((call) => call.hostnames)).toContain("mail.global.lndo.site");
          const job = rows.find((row) => row.name === "mail");
          expect(job?.state).toBe("completed");
          expect(job?.connections.length).toBeGreaterThan(0);
          expect(job?.connections.every((connection) => connection.state === "inactive")).toBe(true);
          expect(rows.find((row) => row.name === "proxy")?.connections).toContainEqual(
            expect.objectContaining({
              source: "route",
              state: "active",
              url: "https://proxy.global.lndo.site:444",
            }),
          );
        },
        { completedServices: ["mail"] },
      );
    },
  );

  test("stop-all then start-one publishes only the selected service routes", async () => {
    await withHarness(async (harness) => {
      // Given both global services were running before stop-all.
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
      harness.calls.routes.length = 0;
      // When only mail is started again.
      await Effect.runPromise(globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)));
      // Then stopped sibling routes stay withdrawn and setup never runs.
      expect(harness.calls.routes).toEqual([{ app: "global", hostnames: ["mail.global.lndo.site"] }]);
      expect(harness.calls.routerSetups).toEqual([]);
    });
  });

  test("start-one preserves routes of running owned siblings", async () => {
    await withHarness(async (harness) => {
      // Given proxy is already running.
      await Effect.runPromise(globalStart({ services: ["proxy"] }).pipe(Effect.provide(harness.layer)));
      harness.calls.routes.length = 0;
      // When mail starts independently.
      await Effect.runPromise(globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)));
      // Then both running services remain routed without setup.
      expect(harness.calls.routes).toEqual([
        { app: "global", hostnames: ["mail.global.lndo.site", "proxy.global.lndo.site"] },
      ]);
      expect(harness.calls.routerSetups).toEqual([]);
    });
  });

  test("selected routed start reports the router global service and its dependencies", async () => {
    await withHarness(
      async (harness) => {
        // Given the selected router implementation names a declared global service with a dependency.
        // When mail is explicitly selected.
        const result = await Effect.runPromise(
          globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        // Then the router dependency closure is started and reported in plan order.
        expect(result.servicesStarted.map((service) => service.name)).toEqual([
          "mail",
          "traefik",
          "traefik-diagnostics",
        ]);
        expect(harness.calls.apply.flatMap(({ plan }) => Object.keys(plan.services))).toEqual([
          "mail",
          "traefik",
          "traefik-diagnostics",
        ]);
        expect(harness.calls.routerSetups).toEqual([]);
      },
      { routerId: "traefik", serviceNames: ["traefik", "mail", "traefik-diagnostics"] },
    );
  });

  test("start with unknown --service fails before applying a plan", async () => {
    await withHarness(async (harness) => {
      const exit = await Effect.runPromiseExit(
        globalStart({ services: ["nope"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.apply).toEqual([]);
      expect(harness.calls.build).toEqual([]);
      expect(harness.calls.inspect).toEqual([]);
      const error = failureOf(exit) as { readonly _tag: string; readonly message: string };
      expect(error._tag).toBe("ToolingExecError");
      expect(error.message).toContain("nope");
      expect(error.message).toContain("available: mail, proxy");
    });
  });

  test("start publishes scope:global pre/post-global-start in order", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart({}).pipe(Effect.provide(harness.layer)));

      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-start" || event._tag === "post-global-start",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-start", "post-global-start"]);
      expect(lifecycle.every((event) => (event as { scope?: string }).scope === "global")).toBe(true);

      const pre = harness.events.find((event) => event._tag === "pre-global-start") as {
        triggeredBy?: string;
        cached?: boolean;
        ensuringServices?: ReadonlyArray<string>;
        app?: { id?: string; kind?: string };
      };
      expect(pre.triggeredBy).toBe("meta:global:start");
      expect(pre.cached).toBe(false);
      expect(pre.ensuringServices).toEqual([]);
      expect(pre.app?.id).toBe("global");
      expect(pre.app?.kind).toBe("global");
    });
  });

  test("start emits no global lifecycle events when an unknown --service aborts before apply", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromiseExit(globalStart({ services: ["nope"] }).pipe(Effect.provide(harness.layer)));

      expect(
        harness.events.filter(
          (event) => event._tag === "pre-global-start" || event._tag === "post-global-start",
        ),
      ).toEqual([]);
    });
  });

  test("stop publishes scope:global pre/post-global-stop in order", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness);

      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));

      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-stop" || event._tag === "post-global-stop",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-stop", "post-global-stop"]);
      expect(lifecycle.every((event) => (event as { scope?: string }).scope === "global")).toBe(true);
      const pre = harness.events.find((event) => event._tag === "pre-global-stop") as {
        triggeredBy?: string;
      };
      expect(pre.triggeredBy).toBe("meta:global:stop");
    });
  });

  test("stop emits no global lifecycle events when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));

      expect(
        harness.events.filter(
          (event) => event._tag === "pre-global-stop" || event._tag === "post-global-stop",
        ),
      ).toEqual([]);
    });
  });

  test("a post-global-start subscriber observes it before a per-app service boots", async () => {
    await withHarness(async (harness) => {
      const preAppStart = Schema.decodeUnknownSync(PreAppStartEvent)({
        _tag: "pre-app-start",
        eventName: "pre-app-start",
        appRef: { kind: "user", id: "myapp", root: "/srv/apps/myapp" },
        providerId: "lando",
        timestamp: DateTime.formatIso(DateTime.makeUnsafe("2026-05-31T07:30:00Z")),
      });

      const layer = Layer.mergeAll(harness.layer, LandoEventService.layer);

      const tags = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            yield* globalStart({});
            yield* eventService.publish(preAppStart);

            const collected: Array<string> = [];
            while (true) {
              const event = yield* Queue.take(queue);
              collected.push(event._tag);
              if (event._tag === "pre-app-start") break;
            }
            return collected;
          }),
        ).pipe(Effect.provide(layer)),
      );

      expect(tags).toContain("post-global-start");
      expect(tags.indexOf("post-global-start")).toBeGreaterThanOrEqual(0);
      expect(tags.indexOf("post-global-start")).toBeLessThan(tags.indexOf("pre-app-start"));
    });
  });

  test("stop destroys provider resources without volumes or state removal", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness);

      const result = await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.destroy).toHaveLength(1);
      expect(String(harness.calls.destroy[0]?.target.app)).toBe("global");
      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: false, removeState: false });
      expect(result.materialized).toBe(true);
      expect(result.servicesStopped).toEqual(["proxy"]);
    });
  });

  test("stopping and destroying global services remove only the global route file", async () => {
    await withHarness(async (harness) => {
      await globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer), Effect.runPromise);
      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
      expect(harness.calls.routesRemoved).toEqual(["global"]);
      await Effect.runPromise(globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)));
      expect(harness.calls.routesRemoved).toEqual(["global", "global"]);
    });
  });

  test("stop succeeds without provider calls when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.destroy).toEqual([]);
      expect(result.materialized).toBe(false);
      expect(result.servicesStopped).toEqual([]);
    });
  });

  test("status inspects planned global services and supports a service subset", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      const result = await Effect.runPromise(
        globalStatus({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.inspect.map((call) => String(call.target.service))).toEqual(["mail"]);
      expect(result.materialized).toBe(true);
      expect(result.services.map((service) => service.service)).toEqual(["mail"]);
      expect(result.services.flatMap((service) => service.connections)).toContainEqual(
        expect.objectContaining({
          source: "publication",
          state: "active",
          protocol: "tcp",
          url: "tcp://localhost:8443",
        }),
      );
    });
  });

  test("status with unknown --service fails before rendering an empty table", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      const exit = await Effect.runPromiseExit(
        globalStatus({ services: ["nope"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.inspect).toEqual([]);
      const error = failureOf(exit) as { readonly _tag: string; readonly message: string };
      expect(error._tag).toBe("ToolingExecError");
      expect(error.message).toContain("nope");
      expect(error.message).toContain("available: mail, proxy");
      expect(error.message).not.toContain("(no services)");
    });
  });

  test("status shows desired catalog services before the global app is materialized", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.inspect).toEqual([]);
      expect(result.materialized).toBe(false);
      expect(result.services.map((service) => service.service)).toEqual(["mail", "proxy"]);
      expect(
        result.services.every(
          (service) =>
            service.desired === "enabled" && service.status === "stopped" && service.pending.length === 0,
        ),
      ).toBe(true);
    });
  });

  test("status preserves observed running state when detailed inspection fails", async () => {
    await withHarness(
      async (harness) => {
        await applyGlobalDist(harness, {
          proxy: { type: "lando", home: false },
          mail: { type: "lando", home: false },
        });

        const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

        expect(result.materialized).toBe(true);
        expect(result.services.map((service) => service.service).sort()).toEqual(["mail", "proxy"]);
        expect(result.services.every((service) => service.status === "running")).toBe(true);
        expect(result.runtimeState).toBe("available");
      },
      { failInspect: true },
    );
  });

  test("status exposes disabled running resources and pending cleanup despite an invalid desired Landofile", async () => {
    const options = { failRemove: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.failRemove = true;
      await Effect.runPromiseExit(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      await writeFile(join(harness.dataRoot, "global", ".lando.yml"), "services:\n  invalid line\n");

      const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

      expect(result.policyState).toBe("available");
      expect(result.runtimeState).toBe("available");
      expect(result.services.find((service) => service.service === "mail")).toMatchObject({
        desired: "disabled",
        status: "running",
        pending: expect.arrayContaining([expect.objectContaining({ phase: "containers" })]),
      });
    }, options);
  });

  test("status retains desired policy and unknown runtime state while the provider is offline", async () => {
    const options = { offline: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.offline = true;

      const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

      expect(result.runtimeState).toBe("unavailable");
      expect(result.services.length).toBeGreaterThan(0);
      expect(
        result.services.every((service) => service.desired === "enabled" && service.status === "unknown"),
      ).toBe(true);
      expect(result.diagnostics.join(" ")).toContain("resource state is unknown");
    }, options);
  });

  for (const missingAppliedState of [false, true]) {
    test(`status keeps ownership unknown (missing applied state: ${missingAppliedState})`, async () => {
      const options = { incompleteObservationOwnership: false, missingAppliedState: false };
      await withHarness(async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        options.incompleteObservationOwnership = true;
        options.missingAppliedState = missingAppliedState;
        harness.calls.inspect.length = 0;

        const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

        expect(result.services.every((service) => service.status === "unknown")).toBe(true);
        expect(result.services.flatMap((service) => service.connections)).toEqual([]);
        expect(harness.calls.inspect).toEqual([]);
        expect(result.pending).toContainEqual(expect.objectContaining({ phase: "evidence" }));
        expect(result.diagnostics.join(" ")).toContain("incomplete ownership");
      }, options);
    });
  }

  test("status does not infer running services from applied state absent from inventory", async () => {
    const options = { vanishedServices: [] as string[] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.vanishedServices = ["mail", "proxy"];
      harness.calls.inspect.length = 0;

      const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

      expect(result.runtimeState).toBe("available");
      expect(result.services.every((service) => service.status === "stopped")).toBe(true);
      expect(result.services.flatMap((service) => service.connections)).toEqual([]);
      expect(harness.calls.inspect).toEqual([]);
    }, options);
  });

  test("destroy requires --yes before any provider call", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness);
      await writeFile(join(harness.dataRoot, "global", ".lando.yml"), "services:\n  broken line\n");

      const exit = await Effect.runPromiseExit(globalDestroy({}).pipe(Effect.provide(harness.layer)));
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalDestroyConfirmationError);
      expect(harness.calls.destroy).toEqual([]);
    });
  });

  test("destroy with --yes removes provider state while preserving volumes by default", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness);

      const result = await Effect.runPromise(
        globalDestroy({ yes: true }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.destroy).toHaveLength(1);
      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: false, removeState: true });
      expect(result.materialized).toBe(true);
      expect(result.volumesRemoved).toBe(false);
    });
  });

  test("destroy --purge removes provider state and volumes", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness);

      const result = await Effect.runPromise(
        globalDestroy({ yes: true, purge: true }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: true, removeState: true });
      expect(result.volumesRemoved).toBe(true);
    });
  });

  test("disable rejects unknown plugin arguments before provider or dist mutation", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["@lando/proxy-traefik"] }).pipe(Effect.provide(harness.layer)),
      );
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalAppError);
      expect(harness.calls.destroy).toEqual([]);
      expect((await parseDist(distPath(harness.dataRoot))).services).toHaveProperty("proxy");
    });
  });

  test("disable --all creates an empty global dist without starting services", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(
        globalDisable({ all: true }).pipe(Effect.provide(harness.layer)),
      );
      const parsed = await parseDist(distPath(harness.dataRoot));

      expect(result.contributions).toEqual(["mail", "proxy"]);
      expect(result.servicesRemoved).toEqual([]);
      expect(parsed.services).toEqual({});
      expect(harness.calls.destroy).toEqual([]);
    });
  });

  test("a concurrent start finishes before disable removes the disabled service", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    await withHarness(
      async (harness) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const starting = yield* Effect.forkChild(globalStart());
            yield* Deferred.await(entered);
            const disabling = yield* Effect.forkChild(globalDisable({ selectors: ["mail"] }));
            yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(starting);
            return yield* Fiber.join(disabling);
          }).pipe(Effect.provide(harness.layer)),
        );
        expect(result.servicesRemoved).toEqual(["mail"]);
        expect(result.dist?.serviceIds).toEqual(["proxy"]);
        expect(harness.calls.removed).toEqual(["mail"]);
      },
      { beforeApply: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) },
    );
  });

  test("disable disables one contribution, stops only its container and keeps siblings", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const result = await Effect.runPromise(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.contributions).toEqual(["mail"]);
      expect(result.servicesRemoved).toEqual(["mail"]);
      expect(result.dist?.serviceIds).toEqual(["proxy"]);
      expect(harness.calls.removed).toEqual(["mail"]);
      expect(harness.calls.destroy).toEqual([]);
      const list = await Effect.runPromise(globalList().pipe(Effect.provide(harness.layer)));
      expect(list.services.find((s) => s.id === "mail")?.state).toBe("disabled");
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      expect(Object.keys(harness.calls.apply.at(-1)?.plan.services ?? {})).toEqual(["proxy"]);
    });
  });

  test("disable saves disabled intent on cleanup failure and retries safely", async () => {
    const options = { failRemove: true };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        _tag: "GlobalPolicyReconciliationError",
        operation: "disable",
        message: expect.stringContaining("saved"),
      });
      const list = await Effect.runPromise(globalList().pipe(Effect.provide(harness.layer)));
      expect(list.services.find((s) => s.id === "mail")?.enabled).toBe(false);
      expect(harness.calls.destroy).toEqual([]);
      options.failRemove = false;
      const result = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(result.servicesRemoved).toEqual(["mail"]);
      const repeated = await Effect.runPromise(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(repeated.servicesRemoved).toEqual([]);
    }, options);
  });

  test("disable cannot report completed cleanup when the applied provider is offline", async () => {
    const options = { offline: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.offline = true;
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        _tag: "GlobalPolicyReconciliationError",
        message: expect.stringContaining("saved"),
      });
      const list = await Effect.runPromise(globalList().pipe(Effect.provide(harness.layer)));
      expect(list.services.find((s) => s.id === "mail")?.enabled).toBe(false);
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("disable withdraws selected routes even when its container is already absent", async () => {
    await withHarness(
      async (harness) => {
        await mkdir(join(harness.dataRoot, "global"), { recursive: true });
        await writeFile(
          join(harness.dataRoot, "global", ".lando.local.yml"),
          "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
        );
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        const result = await Effect.runPromise(
          globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(result.servicesRemoved).toEqual([]);
        expect(harness.calls.routes.at(-1)?.hostnames).toEqual(["proxy.global.test"]);
      },
      { vanishedServices: ["mail"] },
    );
  });

  test("disable of an owning package disables all its contributions durably", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(
        globalDisable({ selectors: ["@lando/fake-global-command"] }).pipe(Effect.provide(harness.layer)),
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      expect(harness.calls.apply).toEqual([]);
      const list = await Effect.runPromise(globalList().pipe(Effect.provide(harness.layer)));
      expect(list.services.every((s) => !s.enabled)).toBe(true);
    });
  });

  test("disabled invalid overrides stay editable and absent from effective config", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromise(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      await writeFile(
        join(harness.dataRoot, "global", ".lando.yml"),
        'services:\n  mail:\n    home: "{{ env.NOT_SET_FOR_DISABLED_SERVICE }}"\n',
      );
      await Effect.runPromise(
        globalConfig({ subcommand: "set", key: "services.proxy.environment.KEPT", value: "yes" }).pipe(
          Effect.provide(harness.layer),
        ),
      );
      await Effect.runPromise(globalConfig({ subcommand: "validate" }).pipe(Effect.provide(harness.layer)));
      const result = await Effect.runPromise(globalConfig().pipe(Effect.provide(harness.layer)));
      expect(result.landofile?.services).not.toHaveProperty("mail");
      expect(result.landofile?.services?.[ServiceName.make("proxy")]?.environment?.KEPT).toBe("yes");
      expect(await readFile(join(harness.dataRoot, "global", ".lando.yml"), "utf8")).toContain(
        "NOT_SET_FOR_DISABLED_SERVICE",
      );
    });
  });

  test("disable preserves the completed removal prefix when a later container fails", async () => {
    const options = { failRemoveServices: ["mail"] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const exit = await Effect.runPromiseExit(
        globalDisable({ all: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        _tag: "GlobalPolicyReconciliationError",
        policySaved: true,
        servicesRemoved: ["proxy"],
        pending: expect.arrayContaining([
          expect.objectContaining({ phase: "containers", services: ["mail"] }),
        ]),
      });
      const receipt = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(receipt.servicesRemoved).toEqual(["proxy"]);
      expect(harness.calls.destroy).toEqual([]);
      options.failRemoveServices = [];
      const retry = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(retry.servicesRemoved).toEqual(["mail"]);
      expect(retry.pending).toEqual([]);
    }, options);
  });

  test("disable route failure keeps exact removals and reconcile retries without starting containers", async () => {
    const options = { failRoutes: false };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const applies = harness.calls.apply.length;
      options.failRoutes = true;
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        servicesRemoved: ["mail"],
        pending: expect.arrayContaining([expect.objectContaining({ phase: "routes" })]),
      });
      options.failRoutes = false;
      const result = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(result.pending).toEqual([]);
      expect(result.servicesRemoved).toEqual([]);
      expect(harness.calls.routes.at(-1)?.hostnames).toEqual(["proxy.global.test"]);
      expect(harness.calls.apply.length).toBe(applies);
    }, options);
  });

  test("enable cancels selected failed withdrawal without restoring containers or routes", async () => {
    const options = { failRoutes: false };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.failRoutes = true;
      const disabled = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(disabled)).toMatchObject({
        servicesRemoved: ["mail"],
        pending: [expect.objectContaining({ phase: "routes", services: ["mail"] })],
      });
      const pending = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      const canonical = join(harness.dataRoot, "global", ".lando.yml");
      const original = await readFile(canonical, "utf8");
      await writeFile(canonical, "services:\n  mail:\n    home: 17\n");
      const invalid = await Effect.runPromiseExit(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(invalid)).toMatchObject({ _tag: "LandofileWriteValidationError" });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(policy);
      expect(await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)))).toEqual(
        pending,
      );
      await writeFile(canonical, original);
      const before = {
        apply: harness.calls.apply.length,
        removed: [...harness.calls.removed],
        routes: harness.calls.routes.length,
        routesRemoved: harness.calls.routesRemoved.length,
      };
      const enabled = await Effect.runPromise(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(enabled).toMatchObject({ policySaved: true, servicesRemoved: [], pending: [] });
      expect(enabled.dist?.serviceIds).toContain("mail");
      const saved = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(saved.pending).toEqual([]);
      expect(saved.targets).toEqual([]);
      expect(
        (await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).plugins[
          "@lando/fake-global-command"
        ]?.contributions.mail?.enabled,
      ).toBe(true);
      const reconciled = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(reconciled).toMatchObject({ servicesRemoved: [], pending: [] });
      expect(harness.calls.apply).toHaveLength(before.apply);
      expect(harness.calls.removed).toEqual(before.removed);
      expect(harness.calls.routes).toHaveLength(before.routes);
      expect(harness.calls.routesRemoved).toHaveLength(before.routesRemoved);
    }, options);
  });

  test("enable cancels only its selection while unrelated withdrawal remains pending", async () => {
    const options = { failRoutes: false };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.failRoutes = true;
      await Effect.runPromiseExit(globalDisable({ all: true }).pipe(Effect.provide(harness.layer)));
      const before = {
        apply: harness.calls.apply.length,
        removed: [...harness.calls.removed],
        routes: harness.calls.routes.length,
      };
      const enabled = await Effect.runPromiseExit(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(enabled)).toMatchObject({
        _tag: "GlobalPolicyReconciliationError",
        policySaved: true,
        contributions: ["mail"],
        servicesRemoved: [],
        pending: [expect.objectContaining({ phase: "routes", services: ["proxy"] })],
      });
      const saved = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(saved.pending).toEqual([expect.objectContaining({ phase: "routes", services: ["proxy"] })]);
      expect(saved.targets?.map((target) => target.id)).toEqual(["proxy"]);
      expect(harness.calls.apply).toHaveLength(before.apply);
      expect(harness.calls.removed).toEqual(before.removed);
      expect(harness.calls.routes).toHaveLength(before.routes);
      options.failRoutes = false;
      const reconciled = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(reconciled).toMatchObject({ contributions: ["proxy"], servicesRemoved: [], pending: [] });
      expect(harness.calls.removed).toEqual(before.removed);
      expect(harness.calls.apply).toHaveLength(before.apply);
      expect(harness.calls.publishedRoutes.at(-1)?.hostnames).toEqual([]);
    }, options);
  });

  test("enable generation failure keeps only current generation work for its selection", async () => {
    const options = { failRoutes: false };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.failRoutes = true;
      await Effect.runPromiseExit(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      const before = {
        apply: harness.calls.apply.length,
        removed: [...harness.calls.removed],
        routes: harness.calls.routes.length,
      };
      const globalApp = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(harness.layer)));
      const failed = await Effect.runPromiseExit(
        globalEnable({ selectors: ["mail"] }).pipe(
          Effect.provideService(GlobalAppService, {
            ...globalApp,
            regenerateDist: () =>
              Effect.fail(
                new GlobalAppError({
                  operation: "regenerateDist",
                  message: "Generation failed.",
                  remediation: "Repair generated configuration storage.",
                }),
              ),
          }),
          Effect.provide(harness.layer),
        ),
      );
      expect(failureOf(failed)).toMatchObject({
        _tag: "GlobalPolicyReconciliationError",
        policySaved: true,
        pending: [expect.objectContaining({ phase: "generation", services: ["mail"] })],
      });
      const saved = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(saved.pending).toEqual([expect.objectContaining({ phase: "generation", services: ["mail"] })]);
      expect(saved.targets).toEqual([]);
      expect(harness.calls.apply).toHaveLength(before.apply);
      expect(harness.calls.removed).toEqual(before.removed);
      expect(harness.calls.routes).toHaveLength(before.routes);
    }, options);
  });

  for (const scope of ["selected", "whole"] as const) {
    test(`reconcile retries durable route withdrawal after a failed ${scope} start replaces applied metadata`, async () => {
      const options = { failRoutes: false };
      await withHarness(async (harness) => {
        await mkdir(join(harness.dataRoot, "global"), { recursive: true });
        await writeFile(
          join(harness.dataRoot, "global", ".lando.local.yml"),
          "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
        );
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        options.failRoutes = true;
        const disabled = await Effect.runPromiseExit(
          globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(disabled)).toMatchObject({
          servicesRemoved: ["mail"],
          pending: expect.arrayContaining([expect.objectContaining({ phase: "routes" })]),
        });
        const restarted = await Effect.runPromiseExit(
          globalStart(scope === "selected" ? { services: ["proxy"] } : {}).pipe(
            Effect.provide(harness.layer),
          ),
        );
        expect(failureOf(restarted)).toBeInstanceOf(ProxyApplyError);
        expect([...(harness.calls.publishedRoutes.at(-1)?.hostnames ?? [])].sort()).toEqual([
          "mail.global.test",
          "proxy.global.test",
        ]);
        const before = await Effect.runPromise(
          readGlobalReconciliation().pipe(Effect.provide(harness.layer)),
        );
        expect(before.pending).toEqual(
          expect.arrayContaining([expect.objectContaining({ phase: "routes", services: ["mail"] })]),
        );
        options.failRoutes = false;
        const attempts = harness.calls.routes.length;
        const reconciled = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
        expect(reconciled.pending).toEqual([]);
        expect(reconciled.servicesRemoved).toEqual([]);
        expect(harness.calls.routes).toHaveLength(attempts + 1);
        expect(harness.calls.publishedRoutes.at(-1)?.hostnames).toEqual(["proxy.global.test"]);
      }, options);
    });
  }

  test("whole-app stop clears durable route failure only after actual route withdrawal", async () => {
    const options = { failRoutes: false };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.failRoutes = true;
      await Effect.runPromiseExit(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      await Effect.runPromiseExit(globalStart({ services: ["proxy"] }).pipe(Effect.provide(harness.layer)));
      expect(harness.calls.publishedRoutes.at(-1)?.hostnames).toContain("mail.global.test");
      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
      expect(harness.calls.publishedRoutes.at(-1)?.hostnames).toEqual([]);
      const receipt = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(receipt.pending).toEqual([]);
      const reconciled = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(reconciled.pending).toEqual([]);
      expect(harness.calls.publishedRoutes.at(-1)?.hostnames).toEqual([]);
    }, options);
  });

  test("disable saves policy and exposes routes pending when applied metadata is missing", async () => {
    const options = { missingAppliedState: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.missingAppliedState = true;
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        policySaved: true,
        servicesRemoved: [],
        pending: expect.arrayContaining([expect.objectContaining({ phase: "routes" })]),
      });
      const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      expect(policy.plugins["@lando/fake-global-command"]?.contributions.mail?.enabled).toBe(false);
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("disable refuses a known authored dependent before changing policy", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await writeFile(
        join(harness.dataRoot, "global", ".lando.yml"),
        "services:\n  proxy:\n    dependsOn:\n      - service: mail\n        condition: service_started\n        required: true\n",
      );
      const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        _tag: "GlobalAppError",
        message: expect.stringContaining("proxy"),
      });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
      expect(harness.calls.removed).toEqual([]);
      const acknowledged = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(acknowledged)).toMatchObject({
        _tag: "GlobalAppError",
        message: expect.stringContaining("proxy"),
      });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
    });
  });

  test("disable removes selected containers before unrelated module generation fails", async () => {
    const options: { brokenModules: string[] } = { brokenModules: [] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.brokenModules = ["proxy"];
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        policySaved: true,
        servicesRemoved: ["mail"],
        pending: expect.arrayContaining([expect.objectContaining({ phase: "generation" })]),
      });
      expect(harness.calls.removed).toEqual(["mail"]);
    }, options);
  });

  test("disable dry-run previews impact without policy, dist or runtime mutation", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      const dist = await readFile(distPath(harness.dataRoot), "utf8");
      const preview = await Effect.runPromise(
        globalDisable({ selectors: ["mail"], dryRun: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(preview).toMatchObject({
        dryRun: true,
        policySaved: false,
        servicesRemoved: [],
        impact: { desired: "disabled", contributions: ["mail"], volumes: "retained", dependencyBlockers: [] },
      });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(policy);
      expect(await readFile(distPath(harness.dataRoot), "utf8")).toBe(dist);
      expect(harness.calls.removed).toEqual([]);
    });
  });

  test("disable dry-run leaves fresh roots and local include pins untouched", async () => {
    await withHarness(async (harness) => {
      const confRoot = String(process.env.LANDO_USER_CONF_ROOT);
      const fresh = await Effect.runPromise(
        globalDisable({ all: true, dryRun: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(fresh.policySaved).toBe(false);
      expect(await readdir(harness.dataRoot)).toEqual([]);
      expect(await readdir(confRoot)).toEqual([]);
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const root = join(harness.dataRoot, "global");
      await writeFile(
        join(root, "fragment.yml"),
        "services:\n  proxy:\n    environment:\n      FROM_INCLUDE: yes\n",
      );
      await writeFile(join(root, ".lando.yml"), "includes: [fragment.yml]\n");
      const before = (await readdir(root, { recursive: true })).sort();
      await Effect.runPromise(
        globalDisable({ selectors: ["mail"], dryRun: true }).pipe(Effect.provide(harness.layer)),
      );
      expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
      expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
    });
  });

  for (const ownership of [
    { name: "missing root", incompleteObservationOwnership: true },
    { name: "mismatched provider", observationProviderId: ProviderId.make("foreign") },
    {
      name: "missing root and mismatched provider",
      incompleteObservationOwnership: true,
      observationProviderId: ProviderId.make("foreign"),
    },
  ]) {
    test(`disable preserves intent and evidence pending for ${ownership.name} without applied state`, async () => {
      const options: HarnessOptions & {
        missingAppliedState: boolean;
        incompleteObservationOwnership?: boolean;
        observationProviderId?: ProviderId;
      } = { missingAppliedState: false };
      await withHarness(async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        options.missingAppliedState = true;
        if (ownership.incompleteObservationOwnership !== undefined)
          options.incompleteObservationOwnership = ownership.incompleteObservationOwnership;
        if (ownership.observationProviderId !== undefined)
          options.observationProviderId = ownership.observationProviderId;
        await rm(distPath(harness.dataRoot));
        const routes = harness.calls.routes.length;
        const pending = await Effect.runPromiseExit(
          globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(pending)).toMatchObject({
          _tag: "GlobalPolicyReconciliationError",
          policySaved: true,
          servicesRemoved: [],
          pending: expect.arrayContaining([
            expect.objectContaining({ phase: "evidence", services: ["mail"] }),
          ]),
        });
        const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
        expect(policy.plugins["@lando/fake-global-command"]?.contributions.mail?.enabled).toBe(false);
        const receipt = await Effect.runPromise(
          readGlobalReconciliation().pipe(Effect.provide(harness.layer)),
        );
        expect(receipt.pending).toEqual(
          expect.arrayContaining([expect.objectContaining({ phase: "evidence", services: ["mail"] })]),
        );
        expect(harness.calls.removed).toEqual([]);
        expect(harness.calls.destroy).toEqual([]);
        expect(harness.calls.routes).toHaveLength(routes);
      }, options);
    });
  }

  test("disable ignores a selected-name observation proven to belong to another root", async () => {
    const options: HarnessOptions & { missingAppliedState: boolean; observationRoot?: AbsolutePath } = {
      missingAppliedState: false,
      vanishedServices: ["proxy"],
    };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.missingAppliedState = true;
      options.observationRoot = AbsolutePath.make(join(harness.dataRoot, "foreign-root"));
      await rm(distPath(harness.dataRoot));
      const result = await Effect.runPromise(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.pending).toEqual([]);
      expect(result.servicesRemoved).toEqual([]);
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  for (const kind of ["user", "scratch"] as const) {
    test(`disable protects a running ${kind} consumer unless disruption is acknowledged`, async () => {
      const options = { consumerPlans: [] as AppPlan[], consumerObservations: [] as ServiceRuntimeInfo[] };
      await withHarness(async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        const consumer = await registerConsumer(harness, options, kind, ["mail"]);
        const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
        const preview = await Effect.runPromise(
          globalDisable({ selectors: ["mail"], dryRun: true }).pipe(Effect.provide(harness.layer)),
        );
        expect(preview.impact.consumers).toEqual([
          expect.objectContaining({ id: consumer.id, kind, globalServices: ["mail"] }),
        ]);
        const refused = await Effect.runPromiseExit(
          globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(refused)).toMatchObject({
          _tag: "GlobalConsumerProtectionError",
          policySaved: false,
          consumers: [expect.objectContaining({ id: consumer.id, kind })],
        });
        expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(
          before,
        );
        expect(harness.calls.removed).toEqual([]);
        const acknowledged = await Effect.runPromise(
          globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
        );
        expect(acknowledged.impact.allowDisruption).toBe(true);
        expect(acknowledged.servicesRemoved).toEqual(["mail"]);
        expect(options.consumerObservations).toHaveLength(1);
        expect(harness.calls.destroy).toEqual([]);
      }, options);
    });
  }

  test("disable protects a legacy routed app without an explicit router requirement", async () => {
    const options = {
      consumerPlans: [] as AppPlan[],
      consumerObservations: [] as ServiceRuntimeInfo[],
      routerId: "proxy",
    };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await registerConsumer(harness, options, "user", [], true);
      const refusal = await Effect.runPromiseExit(
        globalDisable({ selectors: ["proxy"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(refusal)).toMatchObject({
        _tag: "GlobalConsumerProtectionError",
        consumers: [expect.objectContaining({ globalServices: ["proxy"], routes: ["consumer.global.test"] })],
      });
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("disable refuses unreadable consumer evidence before saving policy", async () => {
    const options = { unreadableConsumerState: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      options.unreadableConsumerState = true;
      const refusal = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(refusal)).toMatchObject({
        _tag: "GlobalConsumerProtectionError",
        policySaved: false,
        uncertainties: [expect.stringContaining("unreadable")],
      });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
      expect(harness.calls.removed).toEqual([]);
      const acknowledged = await Effect.runPromise(
        globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(acknowledged.servicesRemoved).toEqual(["mail"]);
    }, options);
  });

  test("disable refuses offline consumer uncertainty before saving without acknowledgement", async () => {
    const options = { offline: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      options.offline = true;
      const refused = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(refused)).toMatchObject({
        _tag: "GlobalConsumerProtectionError",
        policySaved: false,
        uncertainties: [expect.stringContaining("unreachable")],
      });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("reconcile rechecks consumer protection without changing saved intent or pending receipts", async () => {
    const options = {
      consumerPlans: [] as AppPlan[],
      consumerObservations: [] as ServiceRuntimeInfo[],
      failRemove: false,
    };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.failRemove = true;
      await Effect.runPromiseExit(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      await registerConsumer(harness, options, "user", ["mail"]);
      const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      const receipt = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      const refused = await Effect.runPromiseExit(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(failureOf(refused)).toMatchObject({ _tag: "GlobalConsumerProtectionError", policySaved: false });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
      expect(await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)))).toEqual(
        receipt,
      );
      options.failRemove = false;
      const acknowledged = await Effect.runPromise(
        globalReconcile({ allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(acknowledged.servicesRemoved).toEqual(["mail"]);
      expect(acknowledged.pending).toEqual([]);
    }, options);
  });

  test("disable still saves false when its reconciliation receipt is corrupt", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await writeFile(join(harness.dataRoot, "global", ".lando.reconciliation.json"), "invalid json");
      const pending = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(pending)).toMatchObject({
        _tag: "GlobalPolicyReconciliationError",
        policySaved: true,
        servicesRemoved: [],
      });
      const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      expect(policy.plugins["@lando/fake-global-command"]?.contributions.mail?.enabled).toBe(false);
      expect(harness.calls.removed).toEqual([]);
    });
  });

  test("disable preserves an active unselected route despite its unrelated module failure", async () => {
    const options = { brokenModules: [] as string[] };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.brokenModules = ["proxy"];
      const pending = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(pending)).toMatchObject({ policySaved: true, servicesRemoved: ["mail"] });
      expect(harness.calls.routes.at(-1)?.hostnames).toEqual(["proxy.global.test"]);
    }, options);
  });

  test("reconcile retains successful whole-app route recovery while dist remains present", async () => {
    const options = { missingAppliedState: false, vanishedServices: [] as string[] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.missingAppliedState = true;
      options.vanishedServices = ["mail", "proxy"];
      const pending = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(pending)).toMatchObject({
        pending: expect.arrayContaining([expect.objectContaining({ phase: "routes" })]),
      });
      await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
      const result = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(result.pending).toEqual([]);
      expect(await Bun.file(distPath(harness.dataRoot)).exists()).toBe(true);
    }, options);
  });

  test("enable validates authored overrides with proposed defaults before saving policy", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromise(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      await writeFile(join(harness.dataRoot, "global", ".lando.yml"), "services:\n  mail:\n    home: 17\n");
      const invalid = await Effect.runPromiseExit(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(invalid)).toMatchObject({ _tag: "LandofileWriteValidationError" });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
      await writeFile(
        join(harness.dataRoot, "global", ".lando.yml"),
        "services:\n  mail:\n    environment:\n      REENABLED: yes\n",
      );
      const applyCount = harness.calls.apply.length;
      const enabled = await Effect.runPromise(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(enabled.dist?.serviceIds).toContain("mail");
      expect(harness.calls.apply).toHaveLength(applyCount);
    });
  });

  test("enable rejects an authored dependency cycle before saving policy", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromise(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      const before = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      await writeFile(
        join(harness.dataRoot, "global", ".lando.yml"),
        "services:\n  mail:\n    dependsOn:\n      - service: proxy\n        condition: service_started\n  proxy:\n    dependsOn:\n      - service: mail\n        condition: service_started\n",
      );
      const invalid = await Effect.runPromiseExit(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(invalid)).toMatchObject({
        _tag: "GlobalAppError",
        message: expect.stringContaining("cycle"),
      });
      expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(before);
    });
  });

  test("disable ignores an unrelated failing contribution absent from fresh runtime inventory", async () => {
    const options = { serviceNames: ["mail", "proxy"], brokenModules: [] as string[] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.serviceNames = ["mail", "proxy", "newcomer"];
      options.brokenModules = ["newcomer"];
      const exit = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({
        policySaved: true,
        servicesRemoved: ["mail"],
        pending: [expect.objectContaining({ phase: "generation" })],
      });
      expect(harness.calls.removed).toEqual(["mail"]);
    }, options);
  });

  test("reconcile retries a retired contribution only with its unchanged applied ownership snapshot", async () => {
    const options = { serviceNames: ["mail", "proxy"], offline: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.offline = true;
      const pending = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(pending)).toMatchObject({ policySaved: true });
      const receipt = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(receipt.targets).toEqual([
        expect.objectContaining({ id: "mail", plugin: "@lando/fake-global-command" }),
      ]);
      options.serviceNames = ["proxy"];
      options.offline = false;
      const result = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(result.contributions).toEqual(["mail"]);
      expect(result.servicesRemoved).toEqual(["mail"]);
      expect(result.pending).toEqual([]);
    }, options);
  });

  test("reconcile preserves a retired target when an authored service reuses its id", async () => {
    const options = { serviceNames: ["mail", "proxy"], offline: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.offline = true;
      await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      options.serviceNames = ["proxy"];
      options.offline = false;
      await writeFile(
        join(harness.dataRoot, "global", ".lando.yml"),
        "services:\n  mail:\n    type: lando\n    home: false\n",
      );
      const preview = await Effect.runPromise(
        globalReconcile({ dryRun: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(preview.contributions).toEqual([]);
      expect(preview.impact.uncertainties).toContain(
        "A retired cleanup target no longer has matching applied and authored ownership evidence; restore that evidence or explicitly stop the whole global app.",
      );
      const pending = await Effect.runPromiseExit(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(failureOf(pending)).toMatchObject({
        servicesRemoved: [],
        pending: expect.arrayContaining([expect.objectContaining({ phase: "evidence", services: ["mail"] })]),
      });
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("disable accepts an authored override that removes a contributed default dependency", async () => {
    await withHarness(
      async (harness) => {
        await materializeDist(harness);
        await writeFile(
          join(harness.dataRoot, "global", ".lando.yml"),
          "services:\n  proxy:\n    dependsOn: []\n",
        );
        const preview = await Effect.runPromise(
          globalDisable({ selectors: ["mail"], dryRun: true }).pipe(Effect.provide(harness.layer)),
        );
        expect(preview.impact.dependencyBlockers).toEqual([]);
        const pending = await Effect.runPromiseExit(
          globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(pending)).toMatchObject({
          _tag: "GlobalPolicyReconciliationError",
          policySaved: true,
        });
        expect(
          (await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).plugins[
            "@lando/fake-global-command"
          ]?.contributions.mail?.enabled,
        ).toBe(false);
      },
      { serviceDependencies: { proxy: ["mail"] } },
    );
  });

  test("enable admits an authored repair of a contributed default cycle", async () => {
    await withHarness(
      async (harness) => {
        await mkdir(join(harness.dataRoot, "global"), { recursive: true });
        await writeFile(
          join(harness.dataRoot, "global", ".lando.yml"),
          "services:\n  mail:\n    dependsOn: []\n",
        );
        const result = await Effect.runPromise(
          globalEnable({ all: true }).pipe(Effect.provide(harness.layer)),
        );
        expect(result.states.every((entry) => entry.state === "enabled")).toBe(true);
        expect(result.dist?.serviceIds).toEqual(["mail", "proxy"]);
        expect(harness.calls.apply).toEqual([]);
      },
      { serviceDependencies: { proxy: ["mail"], mail: ["proxy"] } },
    );
  });

  test("disable saves false but defers cleanup when an unknown active service lacks dependency evidence", async () => {
    const options = { unplannedServices: [] as string[] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.unplannedServices = ["legacy"];
      const pending = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(pending)).toMatchObject({
        policySaved: true,
        servicesRemoved: [],
        pending: expect.arrayContaining([expect.objectContaining({ phase: "evidence" })]),
      });
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("enable of a retained absent package supersedes its pending cleanup without a start", async () => {
    const options = { serviceNames: ["mail", "proxy"], offline: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const applies = harness.calls.apply.length;
      options.offline = true;
      await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
      );
      options.serviceNames = [];
      const result = await Effect.runPromise(
        globalEnable({ selectors: ["@lando/fake-global-command"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.pending).toEqual([]);
      expect(result.contributions).toContain("mail");
      expect(harness.calls.apply).toHaveLength(applies);
      expect(
        (await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)))).pending,
      ).toEqual([]);
    }, options);
  });

  for (const selector of ["package", "contribution", "all"] as const) {
    test(`enable by ${selector} supersedes no-applied cleanup after its plugin disappears`, async () => {
      const options = { missingAppliedState: false, pluginPresent: true };
      await withHarness(async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        options.missingAppliedState = true;
        const disabled = await Effect.runPromiseExit(
          globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(disabled)).toMatchObject({ policySaved: true });
        const prior = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
        expect(prior.pending.some((entry) => entry.phase === "routes")).toBe(true);
        expect(prior.targets).toEqual([]);
        options.pluginPresent = false;
        const selection =
          selector === "all"
            ? { all: true }
            : { selectors: [selector === "package" ? "@lando/fake-global-command" : "mail"] };
        const before = {
          actions: [...harness.calls.actions],
          removed: [...harness.calls.removed],
          routes: harness.calls.routes.length,
          routesRemoved: harness.calls.routesRemoved.length,
        };
        const preview = await Effect.runPromise(
          globalEnable({ ...selection, dryRun: true }).pipe(Effect.provide(harness.layer)),
        );
        expect(preview).toMatchObject({ policySaved: false, states: [] });
        expect(preview.contributions).toContain("mail");
        expect(
          await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer))),
        ).toEqual(prior);
        const enabled = await Effect.runPromise(globalEnable(selection).pipe(Effect.provide(harness.layer)));
        expect(enabled).toMatchObject({ policySaved: true, states: [], pending: [] });
        expect(enabled.contributions).toContain("mail");
        const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
        const owner = policy.plugins["@lando/fake-global-command"];
        if (selector === "contribution") expect(owner?.contributions.mail?.enabled).toBe(true);
        else {
          expect(owner?.enabled).toBe(true);
          expect(owner?.contributions.mail).not.toHaveProperty("enabled");
        }
        expect(await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)))).toMatchObject({
          servicesRemoved: [],
          pending: [],
        });
        expect(harness.calls.actions).toEqual(before.actions);
        expect(harness.calls.removed).toEqual(before.removed);
        expect(harness.calls.routes).toHaveLength(before.routes);
        expect(harness.calls.routesRemoved).toHaveLength(before.routesRemoved);
      }, options);
    });
  }

  test("retained contribution enable preserves unrelated no-applied cleanup until its package is selected", async () => {
    const options = { missingAppliedState: false, pluginPresent: true };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.missingAppliedState = true;
      await Effect.runPromiseExit(globalDisable({ all: true }).pipe(Effect.provide(harness.layer)));
      options.pluginPresent = false;
      const enabled = await Effect.runPromiseExit(
        globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(enabled)).toMatchObject({
        policySaved: true,
        contributions: ["mail"],
        pending: expect.arrayContaining([expect.objectContaining({ services: ["proxy"] })]),
      });
      const saved = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(
        saved.pending.every((entry) => entry.services.length === 1 && entry.services[0] === "proxy"),
      ).toBe(true);
      expect(saved.targets).toEqual([]);
      const enabledPackage = await Effect.runPromise(
        globalEnable({ selectors: ["@lando/fake-global-command"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(enabledPackage.pending).toEqual([]);
      const owner = (await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).plugins[
        "@lando/fake-global-command"
      ];
      expect(owner?.enabled).toBe(true);
      expect(Object.values(owner?.contributions ?? {}).every((entry) => entry.enabled === undefined)).toBe(
        true,
      );
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  test("absent retained enable generation failure does not revive unproven cleanup", async () => {
    const options = { missingAppliedState: false, pluginPresent: true, serviceNames: ["mail"] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.missingAppliedState = true;
      await Effect.runPromiseExit(globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)));
      options.pluginPresent = false;
      const globalApp = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(harness.layer)));
      const failed = await Effect.runPromiseExit(
        globalEnable({ selectors: ["@lando/fake-global-command"] }).pipe(
          Effect.provideService(GlobalAppService, {
            ...globalApp,
            regenerateDist: () =>
              Effect.fail(
                new GlobalAppError({
                  operation: "regenerateDist",
                  message: "Generation failed.",
                  remediation: "Repair generated configuration storage.",
                }),
              ),
          }),
          Effect.provide(harness.layer),
        ),
      );
      expect(failureOf(failed)).toMatchObject({
        policySaved: true,
        contributions: ["mail"],
        pending: [expect.objectContaining({ phase: "generation", services: ["mail"] })],
      });
      expect(
        (await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)))).targets,
      ).toEqual([]);
      expect(
        (await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)))).pending,
      ).toEqual([]);
      expect(harness.calls.removed).toEqual([]);
    }, options);
  });

  for (const applied of [false, true]) {
    test(`enable of a replacement owner preserves ${applied ? "proven" : "unattributed"} old-owner cleanup`, async () => {
      const options = {
        missingAppliedState: false,
        offline: false,
        pluginName: "@lando/fake-global-command",
        serviceNames: ["mail"],
      };
      await withHarness(async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        options.missingAppliedState = !applied;
        options.offline = applied;
        await Effect.runPromiseExit(
          globalDisable({ selectors: ["mail"], allowDisruption: true }).pipe(Effect.provide(harness.layer)),
        );
        const prior = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
        expect(prior.pending.length).toBeGreaterThan(0);
        expect(prior.targets?.length).toBe(applied ? 1 : 0);
        options.offline = false;
        options.pluginName = "@lando/replacement-global-command";
        const before = {
          actions: [...harness.calls.actions],
          removed: [...harness.calls.removed],
          routes: harness.calls.routes.length,
        };
        const preview = await Effect.runPromise(
          globalEnable({ selectors: [options.pluginName], dryRun: true }).pipe(Effect.provide(harness.layer)),
        );
        expect(preview.states.map((entry) => entry.plugin)).toEqual([options.pluginName]);
        expect(preview.impact.uncertainties.join(" ")).toContain("@lando/fake-global-command");
        expect(preview.impact.uncertainties.join(" ")).toContain(options.pluginName);
        const enabled = await Effect.runPromiseExit(
          globalEnable({ selectors: [options.pluginName] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(enabled)).toMatchObject({
          _tag: "GlobalPolicyReconciliationError",
          policySaved: true,
          contributions: ["mail"],
          pending: prior.pending,
        });
        const saved = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
        expect(saved.pending).toEqual(prior.pending);
        expect(saved.targets).toEqual(prior.targets);
        const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
        const ambiguous = await Effect.runPromiseExit(
          globalEnable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(ambiguous)).toMatchObject({ _tag: "GlobalAppError", operation: "policy" });
        expect(await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).toEqual(
          policy,
        );
        const original = await Effect.runPromiseExit(
          globalEnable({ selectors: ["@lando/fake-global-command"] }).pipe(Effect.provide(harness.layer)),
        );
        if (applied) expect(Exit.isSuccess(original)).toBe(true);
        else {
          expect(failureOf(original)).toMatchObject({ policySaved: true, pending: prior.pending });
          expect(
            (await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)))).pending,
          ).toEqual(prior.pending);
        }
        expect(harness.calls.actions).toEqual(before.actions);
        expect(harness.calls.removed).toEqual(before.removed);
        expect(harness.calls.routes).toHaveLength(before.routes);
      }, options);
    });
  }

  test("selected start isolates an unrelated invalid enabled contribution module", async () => {
    await withHarness(
      async (harness) => {
        const result = await Effect.runPromise(
          globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(result.servicesStarted.map((service) => service.name)).toEqual(["mail"]);
        expect(harness.calls.apply.flatMap((call) => Object.keys(call.plan.services))).toEqual(["mail"]);
      },
      { brokenModules: ["proxy"] },
    );
  });

  test("selected start preserves an active sibling route when its unrelated module becomes invalid", async () => {
    const options = { brokenModules: [] as string[] };
    await withHarness(async (harness) => {
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        join(harness.dataRoot, "global", ".lando.local.yml"),
        "services:\n  mail:\n    routes: [mail.global.test]\n  proxy:\n    routes: [proxy.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.brokenModules = ["proxy"];
      await Effect.runPromise(globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)));
      expect([...(harness.calls.routes.at(-1)?.hostnames ?? [])].sort()).toEqual([
        "mail.global.test",
        "proxy.global.test",
      ]);
    }, options);
  });

  test("selected start retains prior unselected settings until that sibling is applied", async () => {
    await withHarness(async (harness) => {
      const local = join(harness.dataRoot, "global", ".lando.local.yml");
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        local,
        "services:\n  proxy:\n    environment:\n      VERSION: old\n    routes: [old.proxy.test]\n  mail:\n    routes: [mail.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await writeFile(
        local,
        "services:\n  proxy:\n    environment:\n      VERSION: unapplied\n    routes: [new.proxy.test]\n  mail:\n    routes: [mail.global.test]\n",
      );
      await Effect.runPromise(globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)));
      const recorded = harness.calls.apply.at(-1)?.options.recordedPlan;
      expect(recorded?.services[ServiceName.make("proxy")]?.environment.VERSION).toBe("old");
      expect([...(harness.calls.routes.at(-1)?.hostnames ?? [])].sort()).toEqual([
        "mail.global.test",
        "old.proxy.test",
      ]);
      expect(Object.keys(harness.calls.apply.at(-1)?.plan.services ?? {})).toEqual(["mail"]);
    });
  });

  test("selected start rejects a route collision with a retained sibling before apply", async () => {
    await withHarness(async (harness) => {
      const local = join(harness.dataRoot, "global", ".lando.local.yml");
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        local,
        "services:\n  proxy:\n    routes: [taken.global.test]\n  mail:\n    routes: [mail.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const applied = harness.calls.apply.length;
      await writeFile(
        local,
        "services:\n  proxy:\n    routes: [new.proxy.test]\n  mail:\n    routes: [taken.global.test]\n",
      );
      const failure = await Effect.runPromiseExit(
        globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(failure)).toMatchObject({
        _tag: "GlobalAppError",
        message: expect.stringContaining("conflicts"),
      });
      expect(harness.calls.apply).toHaveLength(applied);
    });
  });

  test("selected start refuses unknown active unselected ownership without an applied snapshot", async () => {
    const options = { missingAppliedState: false };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const applied = harness.calls.apply.length;
      options.missingAppliedState = true;
      const failure = await Effect.runPromiseExit(
        globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(failure)).toMatchObject({
        _tag: "GlobalAppError",
        message: expect.stringContaining("ownership"),
      });
      expect(harness.calls.apply).toHaveLength(applied);
    }, options);
  });

  test("selected start retains disabled sibling ownership so retired cleanup can still finish", async () => {
    const options = { serviceNames: ["mail", "proxy"], failRemoveServices: ["proxy"] };
    await withHarness(async (harness) => {
      const local = join(harness.dataRoot, "global", ".lando.local.yml");
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(
        local,
        "services:\n  proxy:\n    routes: [proxy.global.test]\n  mail:\n    routes: [mail.global.test]\n",
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromiseExit(
        globalDisable({ selectors: ["proxy"] }).pipe(Effect.provide(harness.layer)),
      );
      await Effect.runPromise(globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)));
      expect(harness.calls.apply.at(-1)?.options.recordedPlan?.services).toHaveProperty("proxy");
      expect(harness.calls.routes.at(-1)?.hostnames).toEqual(["mail.global.test"]);
      options.serviceNames = ["mail"];
      options.failRemoveServices = [];
      await writeFile(local, "services:\n  mail:\n    routes: [mail.global.test]\n");
      const recovered = await Effect.runPromise(globalReconcile().pipe(Effect.provide(harness.layer)));
      expect(recovered.servicesRemoved).toEqual(["proxy"]);
      expect(recovered.pending).toEqual([]);
    }, options);
  });

  test("a later successful group does not persist settings from a failed selected group", async () => {
    const options = { serviceNames: ["a", "c", "sibling"], failApply: [] as string[] };
    await withHarness(async (harness) => {
      const local = join(harness.dataRoot, "global", ".lando.local.yml");
      await mkdir(join(harness.dataRoot, "global"), { recursive: true });
      await writeFile(local, "services:\n  a:\n    environment:\n      VERSION: old\n");
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await writeFile(local, "services:\n  a:\n    environment:\n      VERSION: attempted\n");
      options.failApply = ["a"];
      const failure = await Effect.runPromiseExit(
        globalStart({ services: ["a", "c"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(failure)).toBeInstanceOf(GlobalAppError);
      expect(
        harness.calls.apply.at(-1)?.options.recordedPlan?.services[ServiceName.make("a")]?.environment
          .VERSION,
      ).toBe("old");
    }, options);
  });

  test("selected start preserves unrelated pending global configuration repair", async () => {
    const options = { serviceNames: ["mail", "proxy", "healthy"], brokenModules: [] as string[] };
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      options.brokenModules = ["proxy"];
      const pending = await Effect.runPromiseExit(
        globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(pending)).toMatchObject({
        pending: [expect.objectContaining({ phase: "generation" })],
      });
      await Effect.runPromise(globalStart({ services: ["healthy"] }).pipe(Effect.provide(harness.layer)));
      const receipt = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(harness.layer)));
      expect(receipt.pending.map((entry) => entry.phase)).toEqual(["generation"]);
    }, options);
  });

  test("selected start rejects its own invalid required contribution dependency", async () => {
    await withHarness(
      async (harness) => {
        const invalid = await Effect.runPromiseExit(
          globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
        );
        expect(failureOf(invalid)).toMatchObject({
          _tag: "GlobalAppError",
          message: expect.stringContaining("proxy"),
        });
        expect(harness.calls.apply).toEqual([]);
      },
      { brokenModules: ["proxy"], serviceDependencies: { mail: ["proxy"] } },
    );
  });

  test("config returns the parsed generated global Landofile and overlay path", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(globalConfig().pipe(Effect.provide(harness.layer)));

      expect(result.materialized).toBe(true);
      expect(result.app).toBe("global");
      expect(result.distLandofile).toBe(distPath(harness.dataRoot));
      expect(result.userLandofile).toBe(join(harness.dataRoot, "global", ".lando.yml"));
      if (result.landofile === undefined) throw new Error("expected landofile");
      expect(result.landofile.services).toHaveProperty("proxy");
    });
  });

  test("config reports a canonical TypeScript Landofile as the overlay path", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);
      const root = join(harness.dataRoot, "global");
      await rm(join(root, ".lando.yml"), { force: true });
      await writeFile(join(root, ".lando.ts"), "export default { runtime: 4 };\n");

      const result = await Effect.runPromise(globalConfig().pipe(Effect.provide(harness.layer)));

      expect(result.userLandofile).toBe(join(root, ".lando.ts"));
    });
  });

  test("config displays authored overrides consistently with global planning", async () => {
    // Given generated services and a canonical override written through the config command.
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        proxy: { type: "lando", home: false, environment: { KEEP: "generated" } },
      });
      await Effect.runPromise(
        globalConfig({
          subcommand: "set",
          key: "services.proxy.environment.ISSUE1250",
          value: "authored",
        }).pipe(Effect.provide(harness.layer)),
      );
      // When the config view and global plan read the effective configuration.
      const result = await Effect.runPromise(globalConfig().pipe(Effect.provide(harness.layer)));
      const loaded = await Effect.runPromise(loadGlobalPlan().pipe(Effect.provide(harness.layer)));
      // Then display and planning both preserve the generated map and authored marker.
      expect(result.landofile?.services?.[ServiceName.make("proxy")]?.environment).toEqual({
        KEEP: "generated",
        ISSUE1250: "authored",
      });
      if (!loaded.materialized) throw new Error("expected global plan");
      expect(result.landofile).toEqual(loaded.landofile.document);
    });
  });

  test("config rejects an unrecognized subcommand instead of silently validating", async () => {
    await withHarness(async (harness) => {
      const exit = await Effect.runPromiseExit(
        globalConfig({ subcommand: "bogus" as never }).pipe(Effect.provide(harness.layer)),
      );

      const error = failureOf(exit) as { readonly _tag: string; readonly message: string };
      expect(error._tag).toBe("LandofileWriteValidationError");
      expect(error.message).toContain("bogus");
    });
  });

  test("CLI wiring forwards a mistyped subcommand instead of dropping it to the view default", () => {
    const options = globalConfigOptionsFromInput({ args: { subcommand: "bogus" }, flags: {} });

    if (options.subcommand === undefined) throw new Error("expected subcommand");
    expect(`${options.subcommand}`).toBe("bogus");
  });

  test("list enumerates every contributed global service from the plugin registry", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalList().pipe(Effect.provide(harness.layer)));

      expect(result.services.map((service) => service.id)).toEqual(["mail", "proxy"]);
      expect(result.services.every((service) => service.plugin === "@lando/fake-global-command")).toBe(true);
      expect(result.services.every((service) => service.enabled && service.state === "enabled")).toBe(true);
      expect(harness.calls.inspect, "list is a catalog surface and never inspects the provider").toEqual([]);
    });
  });

  test("list reports a disabled catalog state for enabledByDefault:false contributions", async () => {
    await withHarness(async (harness) => {
      const disabledManifest = Schema.decodeSync(PluginManifest)({
        name: "@lando/fake-disabled-global",
        version: "1.0.0",
        api: 4,
        contributes: { globalServices: [{ id: "logexplorer", enabledByDefault: false }] },
      });
      const layer = Layer.mergeAll(
        harness.layer,
        Layer.succeed(
          PluginRegistry,
          PluginRegistry.of({
            list: Effect.succeed([disabledManifest]),
            load: () => Effect.succeed(disabledManifest),
            loadServiceType: () => Effect.die("not used"),
            loadServiceFeature: () => Effect.die("not used"),
            loadAppFeature: () => Effect.die("not used"),
          }),
        ),
      );

      const result = await Effect.runPromise(globalList().pipe(Effect.provide(layer)));

      expect(result.services).toMatchObject([
        {
          id: "logexplorer",
          plugin: "@lando/fake-disabled-global",
          enabled: false,
          state: "disabled",
          commands: [],
        },
      ]);
    });
  });

  test("info inspects the global plan and reuses the app-info service shape", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      const result = await Effect.runPromise(globalInfo().pipe(Effect.provide(harness.layer)));

      expect(result.app).toBe("global");
      expect(result.services.map((service) => service.service).sort()).toEqual(["mail", "proxy"]);
      expect(result.services.every((service) => service.status === "running")).toBe(true);
      expect(result.services.every((service) => service.connections.length > 0)).toBe(true);
    });
  });

  test("info with --service filters to the selected subset and rejects unknown services", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      const scoped = await Effect.runPromise(
        globalInfo({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(scoped.services.map((service) => service.service)).toEqual(["mail"]);

      const exit = await Effect.runPromiseExit(
        globalInfo({ services: ["nope"] }).pipe(Effect.provide(harness.layer)),
      );
      const error = failureOf(exit) as { readonly _tag: string; readonly message: string };
      expect(error._tag).toBe("ToolingExecError");
      expect(error.message).toContain("nope");
      expect(error.message).toContain("available: mail, proxy");
    });
  });

  test("info returns an empty success when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalInfo().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.inspect).toEqual([]);
      expect(result).toEqual({ app: "global", services: [] });
    });
  });

  test("restart stops then starts the global app (stop destroy precedes start apply)", async () => {
    await withHarness(async (harness) => {
      await applyGlobalDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      const result = await Effect.runPromise(globalRestart().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.destroy).toHaveLength(1);
      expect(harness.calls.apply).toHaveLength(2);
      expect(result.servicesStarted.map((service) => service.name).sort()).toEqual(["mail", "proxy"]);

      const lifecycle = harness.events
        .filter((event) => event._tag.startsWith("pre-global-") || event._tag.startsWith("post-global-"))
        .map((event) => event._tag);
      expect(lifecycle).toEqual([
        "pre-global-stop",
        "post-global-stop",
        "pre-global-start",
        "post-global-start",
      ]);
      expect(harness.calls.routerSetups).toEqual([]);
    });
  });

  test.each(["restart", "rebuild"] as const)(
    "%s skips router revalidation after explicit disable",
    async (command) => {
      const revalidated: string[] = [];
      await withHarness(
        async (harness) => {
          await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
          await Effect.runPromise(
            globalDisable({ selectors: ["traefik", "traefik-diagnostics"], allowDisruption: true }).pipe(
              Effect.provide(harness.layer),
            ),
          );
          await Effect.runPromise(
            (command === "restart" ? Effect.asVoid(globalRestart()) : Effect.asVoid(globalRebuild())).pipe(
              Effect.provide(harness.layer),
            ),
          );
          expect(revalidated).toEqual([]);
          expect(
            Object.keys(
              harness.calls.apply.at(-1)?.options.recordedPlan?.services ??
                harness.calls.apply.at(-1)?.plan.services ??
                {},
            ),
          ).not.toContain("traefik");
        },
        {
          serviceNames: independentGlobalServices,
          routerId: "traefik",
          revalidateStartup: Effect.sync(() => {
            revalidated.push("unexpected");
          }).pipe(Effect.andThen(failingWatcherObservation("2026-11-01T00:00:00.000Z"))),
        },
      );
    },
  );

  test.each(["restart", "rebuild"] as const)(
    "%s preserves partial startup failure without revalidating an unapplied router",
    async (command) => {
      const revalidated: string[] = [];
      const options = {
        serviceNames: independentGlobalServices,
        routerId: "traefik",
        failApply: [] as string[],
        revalidateStartup: Effect.sync(() => {
          revalidated.push("unexpected");
        }).pipe(Effect.andThen(failingWatcherObservation("2026-11-01T00:00:00.000Z"))),
      };
      await withHarness(async (harness) => {
        await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
        options.failApply = ["traefik"];
        const failed = await Effect.runPromiseExit(
          (command === "restart" ? Effect.asVoid(globalRestart()) : Effect.asVoid(globalRebuild())).pipe(
            Effect.provide(harness.layer),
          ),
        );
        expect(failureOf(failed)).toMatchObject({
          _tag: "GlobalAppError",
          message: expect.stringContaining("traefik"),
        });
        expect(revalidated).toEqual([]);
      }, options);
    },
  );

  test("restart clears a stale router watcher record", async () => {
    await withHarness(
      async (harness) => {
        // Given a persisted failure from an earlier startup.
        await materializeDist(harness);
        await writeWatcherRecord("2026-09-19T10:00:00.000Z");
        const path = watcherRecordPath();
        expect(await Bun.file(path).exists()).toBe(true);

        // When the restarted router is healthy.
        await Effect.runPromise(globalRestart().pipe(Effect.provide(harness.layer)));

        // Then the healthy observation clears the stale record on disk.
        expect(await Bun.file(path).exists()).toBe(false);
      },
      { routerId: "proxy", revalidateStartup: Effect.promise(() => rm(watcherRecordPath())) },
    );
  });

  test("restart fails when the watcher is still broken and keeps the record", async () => {
    const observedAt = "2026-09-20T10:00:00.000Z";
    await withHarness(
      async (harness) => {
        // Given a stale diagnostic and a watcher that still fails.
        await materializeDist(harness);
        await writeWatcherRecord("2026-09-19T10:00:00.000Z");

        // When restart re-observes startup.
        const exit = await Effect.runPromiseExit(globalRestart().pipe(Effect.provide(harness.layer)));

        // Then the typed failure retains a fresh diagnostic, not the stale one.
        expect(failureOf(exit)).toMatchObject({ _tag: "RouterWatcherError" });
        expect(await Bun.file(watcherRecordPath()).exists()).toBe(true);
        expect(JSON.parse(await readFile(watcherRecordPath(), "utf8"))).toMatchObject({ observedAt });
      },
      { routerId: "proxy", revalidateStartup: failingWatcherObservation(observedAt) },
    );
  });

  test("rebuild does not publish the post event when revalidation fails", async () => {
    const observedAt = "2026-09-20T10:00:00.000Z";
    await withHarness(
      async (harness) => {
        // Given a previously recorded watcher failure that persists after rebuild.
        await writeWatcherRecord("2026-09-19T10:00:00.000Z");

        // When rebuild revalidates startup.
        const exit = await Effect.runPromiseExit(globalRebuild({}).pipe(Effect.provide(harness.layer)));

        // Then no successful post event escapes the typed watcher failure.
        expect(failureOf(exit)).toMatchObject({ _tag: "RouterWatcherError" });
        expect(harness.events.map((event) => event._tag)).toContain("pre-global-rebuild");
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
        expect(JSON.parse(await readFile(watcherRecordPath(), "utf8"))).toMatchObject({ observedAt });
      },
      { routerId: "proxy", revalidateStartup: failingWatcherObservation(observedAt) },
    );
  });

  test("rebuild revalidates before publishing the post event", async () => {
    // Given one ordered timeline for router observations and published events.
    const timeline: Array<string> = [];
    await withHarness(
      async (harness) => {
        // When rebuild completes with a healthy watcher.
        const exit = await Effect.runPromiseExit(globalRebuild({}).pipe(Effect.provide(harness.layer)));

        // Then observation precedes the successful post event.
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(harness.events.map((event) => event._tag)).toContain("post-global-rebuild");
        expect(timeline).toContain("router-revalidated");
        expect(timeline.indexOf("router-revalidated")).toBeLessThan(timeline.indexOf("post-global-rebuild"));
      },
      {
        timeline,
        routerId: "proxy",
        revalidateStartup: Effect.sync(() => {
          timeline.push("router-revalidated");
        }),
      },
    );
  });

  test("rebuild publishes rebuilt routes and reports route URLs without router setup", async () => {
    await withHarness(async (harness) => {
      await authorGlobalSecretBindings(harness.dataRoot, ["mail", "proxy"]);
      const result = await Effect.runPromise(globalRebuild({}).pipe(Effect.provide(harness.layer)));

      expect(harness.calls.buildOptions).toEqual([{ refresh: true }, { refresh: true }]);

      expect(harness.calls.destroy).toHaveLength(1);
      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: false, removeState: false });
      expect(harness.calls.build).toHaveLength(2);
      expect(harness.calls.apply).toHaveLength(2);
      expect(harness.calls.apply[0]?.options.reconcile).toBe(true);
      expect(harness.calls.apply[0]?.environments[ServiceName.make("mail")]).toMatchObject({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.environments[ServiceName.make("proxy")]).toMatchObject({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.plan.services[ServiceName.make("proxy")]?.environment).toEqual({
        LANDO_HOST_IP: "host.lando.internal",
        TOKEN: { _tag: "SecretRef", reference: "GLOBAL_TOKEN" },
      });
      expect(
        Object.values(harness.calls.apply[1]?.plan.services ?? {}).find(
          (service) => String(service.name) === "proxy",
        )?.artifact,
      ).toEqual({
        kind: "ref",
        ref: "built:proxy",
      });
      expect([...new Set(harness.calls.inspect.map((call) => String(call.target.service)))].sort()).toEqual([
        "mail",
        "proxy",
      ]);
      expect(result.materialized).toBe(true);
      expect(result.servicesRebuilt.map((service) => service.name).sort()).toEqual(["mail", "proxy"]);
      expect(harness.calls.routerSetups).toEqual([]);
      expect(harness.calls.routes).toEqual([
        { app: "global", hostnames: ["mail.global.lndo.site", "proxy.global.lndo.site"] },
      ]);
      expect(result.servicesRebuilt.find((service) => service.name === "mail")?.connections).toContainEqual(
        expect.objectContaining({
          source: "route",
          binding: "assigned",
          state: "active",
          url: "https://mail.global.lndo.site:444",
        }),
      );
    });
  });

  test("rebuild replaces changed hostnames after global config set", async () => {
    await withHarness(async (harness) => {
      // Given the default global routes were previously published.
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromise(
        globalConfig({
          subcommand: "set",
          key: "services.mail.routes",
          type: "json",
          value: '[{"hostname":"changed.lndo.site","endpoint":8080}]',
        }).pipe(Effect.provide(harness.layer)),
      );
      harness.calls.routes.length = 0;
      // When rebuild uses the updated global configuration.
      const result = await Effect.runPromise(globalRebuild().pipe(Effect.provide(harness.layer)));
      // Then the replacement route set omits the stale hostname and reports the new URL.
      expect(harness.calls.routes).toEqual([
        { app: "global", hostnames: ["changed.lndo.site", "proxy.global.lndo.site"] },
      ]);
      expect(result.servicesRebuilt.find((service) => service.name === "mail")?.connections).toContainEqual(
        expect.objectContaining({
          source: "route",
          state: "active",
          url: "https://changed.lndo.site:444",
        }),
      );
      expect(harness.calls.routerSetups).toEqual([]);
    });
  });

  test("rebuild withdraws a route removed from global configuration", async () => {
    await withHarness(async (harness) => {
      // Given a running mail service advertises two authored hostnames.
      await materializeDist(harness);
      await Effect.runPromise(
        globalConfig({
          subcommand: "set",
          key: "services.mail.routes",
          type: "json",
          value:
            '[{"hostname":"kept.lndo.site","endpoint":8080},{"hostname":"removed.lndo.site","endpoint":8080}]',
        }).pipe(Effect.provide(harness.layer)),
      );
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      await Effect.runPromise(
        globalConfig({
          subcommand: "set",
          key: "services.mail.routes",
          type: "json",
          value: '[{"hostname":"kept.lndo.site","endpoint":8080}]',
        }).pipe(Effect.provide(harness.layer)),
      );
      harness.calls.routes.length = 0;
      // When rebuild publishes the reduced configuration.
      await Effect.runPromise(globalRebuild().pipe(Effect.provide(harness.layer)));
      // Then the replacement file no longer contains the removed hostname.
      expect(harness.calls.routes).toEqual([
        { app: "global", hostnames: ["kept.lndo.site", "proxy.global.lndo.site"] },
      ]);
      expect(harness.calls.routerSetups).toEqual([]);
    });
  });

  test("rebuild succeeds without provider calls when no global services are materialized", async () => {
    await withHarness(async (harness) => {
      const layer = Layer.mergeAll(
        harness.layer,
        Layer.succeed(
          PluginRegistry,
          PluginRegistry.of({
            list: Effect.succeed([]),
            load: () => Effect.die("not used"),
            loadServiceType: () => Effect.die("not used"),
            loadServiceFeature: () => Effect.die("not used"),
            loadAppFeature: () => Effect.die("not used"),
          }),
        ),
      );

      const result = await Effect.runPromise(globalRebuild({}).pipe(Effect.provide(layer)));

      expect(harness.calls.destroy).toEqual([]);
      expect(harness.calls.build).toEqual([]);
      expect(harness.calls.apply).toEqual([]);
      expect(harness.calls.inspect).toEqual([]);
      expect(result).toEqual({ app: "global", materialized: true, servicesRebuilt: [] });
    });
  });

  test("rebuild publishes pre/post-global-rebuild only after successful apply and inspect", async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalRebuild({}).pipe(Effect.provide(harness.layer)));

      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-rebuild" || event._tag === "post-global-rebuild",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-rebuild", "post-global-rebuild"]);
      expect(lifecycle.every((event) => event.scope === "global")).toBe(true);
    });
  });

  test("rebuild preserves a missing-provider failure before destructive actions", async () => {
    await withHarness(async (harness) => {
      const missingProvider = new NoProviderInstalledError({
        message: "No runtime provider is installed.",
        remediation: "Run lando setup.",
      });
      const layer = Layer.mergeAll(
        harness.layer,
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            appliedPlansFor: () => Effect.succeed([]),
            list: Effect.succeed([]),
            capabilities: Effect.fail(missingProvider),
            select: () => Effect.fail(missingProvider),
          }),
        ),
      );

      const exit = await Effect.runPromiseExit(globalRebuild({}).pipe(Effect.provide(layer)));

      expect(failureOf(exit)).toBeInstanceOf(NoProviderInstalledError);
      expect(harness.calls.destroy).toEqual([]);
      expect(harness.calls.build).toEqual([]);
      expect(harness.calls.apply).toEqual([]);
      expect(harness.events.map((event) => event._tag)).not.toContain("pre-global-rebuild");
    });
  });

  test("rebuild tags readiness inspection failures and does not publish post-global-rebuild", async () => {
    await withHarness(
      async (harness) => {
        const exit = await Effect.runPromiseExit(globalRebuild({}).pipe(Effect.provide(harness.layer)));
        const failure = failureOf(exit);

        expect(failure).toMatchObject({
          _tag: "ServiceNotReadyError",
          reason: "inspect-failed",
          lastStatus: "provider unavailable",
        });
        expect(harness.events.map((event) => event._tag)).toContain("pre-global-rebuild");
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
      },
      { failInspect: true },
    );
  });

  test("restart uses global start's built plan", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      await Effect.runPromise(globalRestart().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.build).toHaveLength(2);
      expect(harness.calls.apply.flatMap(({ plan }) => artifactRefs(plan)).sort()).toEqual([
        "built:mail",
        "built:proxy",
      ]);
    });
  });

  test("logs collects provider log lines from the materialized global plan", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, { proxy: { type: "lando", home: false } });

      const result = await Effect.runPromise(globalLogs().pipe(Effect.provide(harness.layer)));

      expect(result.app).toBe("global");
      expect(result.lines).toEqual([{ service: "proxy", stream: "stdout", line: "ready" }]);
    });
  });

  test("logs returns an empty success when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalLogs().pipe(Effect.provide(harness.layer)));

      expect(result).toEqual({ app: "global", lines: [] });
    });
  });

  test("logs rejects an invalid --since even when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const exit = await Effect.runPromiseExit(
        globalLogs({ since: "bogus" }).pipe(Effect.provide(harness.layer)),
      );
      const error = failureOf(exit) as { readonly _tag: string; readonly message: string };
      expect(error._tag).toBe("ToolingExecError");
      expect(error.message).toContain('invalid --since value "bogus"');

      const followExit = await Effect.runPromiseExit(
        followGlobalLogs({ since: "bogus" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              harness.layer,
              Layer.succeed(StreamFrameSink, StreamFrameSink.of({ emit: () => Effect.void })),
            ),
          ),
        ),
      );
      const followError = failureOf(followExit) as { readonly _tag: string; readonly message: string };
      expect(followError._tag).toBe("ToolingExecError");
      expect(followError.message).toContain('invalid --since value "bogus"');
    });
  });

  test("follow logs streams provider chunks through the StreamFrameSink", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness, { proxy: { type: "lando", home: false } });

      const emitted: Array<{ readonly service?: string; readonly chunk: string }> = [];
      const sinkLayer = Layer.succeed(
        StreamFrameSink,
        StreamFrameSink.of({
          emit: (frame) =>
            Effect.sync(() => {
              emitted.push({
                chunk: typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk),
                ...(frame.service === undefined ? {} : { service: frame.service }),
              });
            }),
        }),
      );

      const result = await Effect.runPromise(
        followGlobalLogs().pipe(Effect.provide(Layer.mergeAll(harness.layer, sinkLayer))),
      );

      expect(result).toEqual({ app: "global" });
      expect(emitted).toEqual([{ service: "proxy", chunk: "ready" }]);
    });
  });
});

for (const failGeneration of [false, true]) {
  test(`global start revalidates a pre-hook disable${failGeneration ? " after nested generation fails" : ""}`, async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)));
      harness.calls.build.length = 0;
      harness.calls.apply.length = 0;
      harness.events.length = 0;
      const events = await Effect.runPromise(EventService.pipe(Effect.provide(harness.layer)));
      const globalApp = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(harness.layer)));
      const hooked = EventService.of({
        ...events,
        publish: (event) =>
          Effect.gen(function* () {
            yield* events.publish(event);
            if (event._tag !== "pre-global-start") return;
            const child = globalDisable({ selectors: ["mail"] });
            const nested = yield* Effect.result(
              (failGeneration
                ? child.pipe(
                    Effect.provideService(GlobalAppService, {
                      ...globalApp,
                      regenerateDist: () =>
                        Effect.fail(
                          new GlobalAppError({
                            operation: "regenerateDist",
                            message: "Injected generation failure",
                            remediation: "Remove the injected failure.",
                          }),
                        ),
                    }),
                  )
                : child
              ).pipe(Effect.provide(harness.layer), Effect.timeout(2000)),
            );
            if (failGeneration)
              expect(nested).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "GlobalPolicyReconciliationError", policySaved: true },
              });
            else expect(nested._tag).toBe("Success");
          }),
      });
      const exit = await Effect.runPromiseExit(
        globalStart({ services: ["mail"] }).pipe(
          Effect.provideService(EventService, hooked),
          Effect.provide(harness.layer),
        ),
      );
      expect(failureOf(exit)).toMatchObject({ _tag: "GlobalAppError", operation: "startup-admission" });
      expect(
        (await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)))).plugins[
          "@lando/fake-global-command"
        ]?.contributions.mail?.enabled,
      ).toBe(false);
      expect(harness.calls.build).toHaveLength(0);
      expect(harness.calls.apply).toHaveLength(0);
      expect(harness.events.filter((event) => event._tag === "post-global-start")).toHaveLength(0);
    });
  });
}

const disableDuringRebuild = (harness: Harness, failGeneration: boolean) =>
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const change = globalDisable({ selectors: ["mail"] });
    const nested = yield* Effect.result(
      failGeneration
        ? change.pipe(
            Effect.provideService(GlobalAppService, {
              ...globalApp,
              regenerateDist: () =>
                Effect.fail(
                  new GlobalAppError({
                    operation: "regenerateDist",
                    message: "Injected nested rebuild generation failure",
                    remediation: "Remove the injected failure.",
                  }),
                ),
            }),
          )
        : change,
    );
    if (failGeneration)
      expect(nested).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GlobalPolicyReconciliationError", policySaved: true },
      });
    else expect(nested._tag).toBe("Success");
  }).pipe(Effect.provide(harness.layer), Effect.timeout(2000), Effect.orDie);

for (const failGeneration of [false, true]) {
  test(`global rebuild rejects a pre-hook disable before teardown${failGeneration ? " when nested generation fails" : ""}`, async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      harness.calls.destroy.length = 0;
      harness.calls.build.length = 0;
      harness.calls.apply.length = 0;
      harness.events.length = 0;
      const events = await Effect.runPromise(EventService.pipe(Effect.provide(harness.layer)));
      const hooked = EventService.of({
        ...events,
        publish: (event) =>
          Effect.gen(function* () {
            yield* events.publish(event);
            if (event._tag === "pre-global-rebuild") yield* disableDuringRebuild(harness, failGeneration);
          }),
      });
      const rebuilt = await Effect.runPromiseExit(
        globalRebuild().pipe(Effect.provideService(EventService, hooked), Effect.provide(harness.layer)),
      );
      expect(failureOf(rebuilt)).toMatchObject({ _tag: "GlobalAppError", operation: "startup-admission" });
      const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      expect(policy.plugins["@lando/fake-global-command"]?.contributions.mail?.enabled).toBe(false);
      expect(harness.calls.destroy).toEqual([]);
      expect(harness.calls.build).toEqual([]);
      expect(harness.calls.apply).toEqual([]);
      expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
    });
  });

  test(`global rebuild rejects a build-time disable before apply${failGeneration ? " when nested generation fails" : ""}`, async () => {
    await withHarness(async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      const recorded = await Effect.runPromise(
        RuntimeProviderRegistry.pipe(
          Effect.flatMap((registry) =>
            registry.appliedPlansFor(AbsolutePath.make(join(harness.dataRoot, "global"))),
          ),
          Effect.provide(harness.layer),
        ),
      );
      harness.calls.destroy.length = 0;
      harness.calls.build.length = 0;
      harness.calls.apply.length = 0;
      harness.events.length = 0;
      const builder = await Effect.runPromise(BuildOrchestrator.pipe(Effect.provide(harness.layer)));
      let disabled = false;
      const hooked = BuildOrchestrator.of({
        ...builder,
        build: (plan, options) =>
          Effect.gen(function* () {
            const built = yield* builder.build(plan, options);
            if (!disabled && Object.hasOwn(plan.services, "mail")) {
              disabled = true;
              yield* disableDuringRebuild(harness, failGeneration);
            }
            return built;
          }),
      });
      const rebuilt = await Effect.runPromiseExit(
        globalRebuild().pipe(Effect.provideService(BuildOrchestrator, hooked), Effect.provide(harness.layer)),
      );
      expect(failureOf(rebuilt)).toMatchObject({ _tag: "GlobalAppError", operation: "startup-admission" });
      expect(disabled).toBe(true);
      expect(harness.calls.destroy).toHaveLength(1);
      expect(harness.calls.build.some((plan) => Object.hasOwn(plan.services, "mail"))).toBe(true);
      expect(harness.calls.apply).toEqual([]);
      const after = await Effect.runPromise(
        RuntimeProviderRegistry.pipe(
          Effect.flatMap((registry) =>
            registry.appliedPlansFor(AbsolutePath.make(join(harness.dataRoot, "global"))),
          ),
          Effect.provide(harness.layer),
        ),
      );
      expect(after).toEqual(recorded);
      const policy = await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(harness.layer)));
      expect(policy.plugins["@lando/fake-global-command"]?.contributions.mail?.enabled).toBe(false);
      expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
    });
  });
}

test("selected global start cannot republish a disabled retained sibling after its cleanup fails", async () => {
  let beforeApply: Effect.Effect<void> = Effect.void;
  await withHarness(
    async (harness) => {
      await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
      expect(harness.calls.publishedRoutes.at(-1)?.hostnames.toSorted()).toEqual([
        "mail.global.lndo.site",
        "proxy.global.lndo.site",
      ]);
      harness.calls.publishedRoutes.length = 0;
      harness.events.length = 0;
      beforeApply = Effect.gen(function* () {
        const nested = yield* Effect.result(globalDisable({ selectors: ["proxy"], allowDisruption: true }));
        expect(nested).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "GlobalPolicyReconciliationError", policySaved: true },
        });
        expect(harness.calls.publishedRoutes.at(-1)?.hostnames).not.toContain("proxy.global.lndo.site");
      }).pipe(Effect.provide(harness.layer), Effect.orDie);
      const exit = await Effect.runPromiseExit(
        globalStart({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );
      expect(failureOf(exit)).toMatchObject({ _tag: "GlobalAppError", operation: "startup-admission" });
      const state = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          const provider = yield* registry.select(ProviderId.make("lando"));
          return {
            policy: yield* readGlobalPolicy(),
            observed: yield* provider.list({ includeUnplanned: true }),
          };
        }).pipe(Effect.provide(harness.layer)),
      );
      expect(state.policy.plugins["@lando/fake-global-command"]?.contributions.proxy?.enabled).toBe(false);
      expect(state.observed.some((row) => row.service === "proxy" && row.status === "running")).toBe(true);
      expect(harness.calls.publishedRoutes).toHaveLength(1);
      expect(harness.calls.publishedRoutes.at(-1)?.hostnames).not.toContain("proxy.global.lndo.site");
      expect(harness.events.filter((event) => event._tag === "post-global-start")).toHaveLength(0);
    },
    { failRemoveServices: ["proxy"], beforeApply: Effect.suspend(() => beforeApply) },
  );
});

test("an awaited global route writer excludes sibling policy changes and competing publishers", async () => {
  await withHarness(async (harness) => {
    await Effect.runPromise(globalStart().pipe(Effect.provide(harness.layer)));
    const plan = harness.calls.apply.at(-1)?.options.completionPlan;
    if (plan === undefined) throw new Error("expected recorded global completion plan");
    const writing = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const result = await Effect.runPromise(
      withGlobalMutation(
        Effect.gen(function* () {
          const router = yield* RouterService;
          const registry = yield* RuntimeProviderRegistry;
          const provider = yield* registry.select(plan.provider);
          const original = yield* readGlobalPolicy();
          const paused = RouterService.of({
            ...router,
            applyRoutes: (routes, app) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(release);
                return yield* router.applyRoutes(routes, app);
              }),
          });
          const fiber = yield* Effect.forkChild(
            globalStart({ services: ["mail"] }).pipe(Effect.provideService(RouterService, paused)),
          );
          yield* Deferred.await(writing);
          const disabling = yield* Effect.result(
            globalDisable({ selectors: ["proxy"], allowDisruption: true }),
          );
          expect(disabling).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "GlobalAppError", operation: "policy-coordination" },
          });
          expect(yield* readGlobalPolicy()).toEqual(original);
          const competing = yield* Effect.result(
            publishGlobalRoutes(router, provider, plan, { started: new Set(["mail"]), failed: new Set() }),
          );
          expect(competing).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "GlobalAppError", operation: "route-coordination" },
          });
          yield* Deferred.succeed(release, undefined);
          const started = yield* Fiber.join(fiber);
          expect(started.servicesStarted.map((service) => service.name)).toEqual(["mail"]);
          const disabled = yield* globalDisable({ selectors: ["proxy"], allowDisruption: true });
          expect(disabled.policySaved).toBe(true);
          return yield* readGlobalPolicy();
        }),
      ).pipe(Effect.provide(harness.layer)),
    );
    expect(result.plugins["@lando/fake-global-command"]?.contributions.proxy?.enabled).toBe(false);
    expect(harness.calls.publishedRoutes.at(-1)?.hostnames).not.toContain("proxy.global.lndo.site");
  });
});
