import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, DateTime, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";

import { publishedEndpointsFromInspect } from "@lando/container-runtime/podman/inspect";
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
  type AppPlan,
  LandofileShape,
  PluginManifest,
  PortablePath,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  ServicePlan,
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
  type ServiceSelector,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { PreAppStartEvent } from "@lando/sdk/events";
import { makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";

import * as AppCacheService from "@lando/engine/cache/service";
import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import { loadGlobalPlan } from "@lando/engine/operations/global-plan";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
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
import { globalRebuild } from "../../src/cli/commands/meta/global-rebuild.ts";
import { globalRestart } from "../../src/cli/commands/meta/global-restart.ts";
import { globalStart } from "../../src/cli/commands/meta/global-start.ts";
import { globalStatus } from "../../src/cli/commands/meta/global-status.ts";
import { globalStop, renderGlobalStopResult } from "../../src/cli/commands/meta/global-stop.ts";
import { globalUninstall } from "../../src/cli/commands/meta/global-uninstall.ts";

interface ApplyCall {
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
  readonly inspect: Array<InspectCall>;
  readonly routes: Array<{ readonly app: string; readonly hostnames: ReadonlyArray<string> }>;
  readonly routerSetups: number[];
  readonly routesRemoved: string[];
}

type HarnessLayer = Layer.Layer<
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
  | SecretStore
>;

interface HarnessOptions {
  readonly failDestroy?: boolean;
  readonly failInspect?: boolean;
  readonly exitedServices?: ReadonlyArray<string>;
  readonly failRouterSetup?: boolean;
  readonly failRoutes?: boolean;
  readonly failApply?: ReadonlyArray<string>;
  readonly serviceNames?: ReadonlyArray<string>;
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
  toServicePlan: ({ name, appRoot, provider = ProviderId.make("lando"), primary = false, metadata }) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "lando",
      provider,
      primary,
      artifact: { kind: "ref", ref: "lando-global-service:test" },
      environment: { TOKEN: "${secret:GLOBAL_TOKEN}" },
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
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-global-command",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [fakeServiceType.id],
      globalServices: (options.serviceNames ?? ["proxy", "mail"]).map((id) => ({
        id,
        module: id === "traefik" || id === "traefik-diagnostics" ? routerModulePath : modulePath,
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
    inspect: [],
    routes: [],
    routerSetups: [],
    routesRemoved: [],
  };
  const events: Array<LandoEvent> = [];
  let appliedPlan: AppPlan | undefined;
  const runningServices = new Set<ServiceName>();
  const providerId = ProviderId.make("lando");
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: String(providerId),
    capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
    appliedPlans: Effect.sync(() => (appliedPlan === undefined ? [] : [appliedPlan])),
    list: () =>
      Effect.sync(() => {
        const plan = appliedPlan;
        return plan === undefined
          ? []
          : [...runningServices].map((service) => ({
              app: plan.id,
              appRoot: plan.root,
              providerId,
              service,
              containerId: `test-${service}`,
              status: "running" as const,
              state: "running",
              endpoints: [],
            }));
      }),
    apply: (plan, applyOptions) =>
      Effect.sync(() => {
        calls.actions.push("apply");
        calls.apply.push({ plan, options: applyOptions });
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
            }),
          )
        : Effect.sync(() => {
            calls.destroy.push({ target, options: destroyOptions });
            runningServices.clear();
            if (destroyOptions.removeState) appliedPlan = undefined;
            return { kind: "destroyed" as const };
          }),
    inspect: (target) => {
      calls.inspect.push({ target });
      if (options.failInspect) {
        return Effect.fail(
          new ProviderUnavailableError({
            providerId: String(providerId),
            operation: "inspect",
            message: "provider unavailable",
          }),
        );
      }
      return Effect.succeed({
        app: target.app,
        service: target.service,
        providerId,
        status: options.exitedServices?.includes(String(target.service)) ? "stopped" : "running",
        state: options.exitedServices?.includes(String(target.service)) ? "stopped" : "running",
        ...(options.exitedServices?.includes(String(target.service)) ? { exitCode: 17 } : {}),
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
        endpoints: publishedEndpointsFromInspect(
          { NetworkSettings: { Ports: { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "8443" }] } } },
          [{ _tag: "published", protocol: "https", port: 443, name: "websecure", publication: {} }],
        ),
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
                : Effect.succeed(result),
            ),
          ),
        removeRoutes: (app) =>
          Effect.sync(() => {
            calls.routesRemoved.push(String(app));
          }),
      }),
    ),
    Layer.succeed(BuildOrchestrator, buildOrchestrator),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
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
  return { dataRoot, layer, calls, events };
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
            expect(harness.events.map((event) => event._tag)).toEqual(
              command === "stop" ? ["pre-global-stop", "post-global-stop"] : [],
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
        // Then materialization is reported without mutation or lifecycle events.
        expect(result.materialized).toBe(true);
        expect(harness.calls.destroy).toEqual([]);
        expect(harness.calls.routesRemoved).toEqual([]);
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
  test("start isolates ssh-agent failure and applies routes only for started services", async () => {
    // Given three independent groups, one with an uncreatable ssh-agent.
    await withHarness(
      async (harness) => {
        // When global start attempts every group.
        const exit = await Effect.runPromiseExit(globalStart({}).pipe(Effect.provide(harness.layer)));

        // Then the router and mailpit remain available without advertising ssh-agent.
        expectPartialFailure(exit, "start");
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
        expect(harness.calls.actions).toEqual(["build", "apply", "build", "apply", "build", "apply"]);
        expect(harness.calls.inspect).toEqual([]);
        expect(harness.calls.routes).toEqual([
          {
            app: "global",
            hostnames: ["mailpit.global.lndo.site"],
          },
        ]);
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
        expect(harness.calls.routes).toEqual([
          { app: "global", hostnames: ["mailpit.global.lndo.site", "ssh-agent.global.lndo.site"] },
        ]);
        expect(harness.calls.inspect).toEqual([]);
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
        expect(harness.calls.routes).toEqual([{ app: "global", hostnames: [] }]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-start");
      },
      { serviceNames: independentGlobalServices, failApply: independentGlobalServices },
    );
  });

  test("all-failed selected start withdraws its route and preserves the original error", async () => {
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
        // Then its stale route is withdrawn without replacing the original failure.
        expect(failureOf(exit)).toMatchObject({ _tag: "ServiceStartError", service: "mail" });
        expect(harness.calls.routes).toEqual([{ app: "global", hostnames: ["proxy.global.lndo.site"] }]);
      },
      { failApply: failed },
    );
  });

  test("all-failed rebuild withdraws all routes and preserves the original error without revalidation", async () => {
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
        // Then all stale routes are withdrawn and the first failure remains primary.
        expect(failureOf(exit)).toMatchObject({ _tag: "ServiceStartError", service: "mail" });
        expect(harness.calls.routes).toEqual([{ app: "global", hostnames: [] }]);
        expect(revalidated).toEqual([]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
      },
      {
        failApply: failed,
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
        // Then inspect is skipped and the first group error wins.
        expectPartialFailure(exit, "rebuild");
        expect(harness.calls.destroy).toHaveLength(1);
        expect(harness.calls.build.map((plan) => Object.keys(plan.services))).toEqual(expectedGlobalGroups);
        expect(harness.calls.apply.map(({ plan }) => Object.keys(plan.services))).toEqual(
          expectedGlobalGroups,
        );
        expect(harness.calls.apply.every(({ options }) => options.reconcile)).toBe(true);
        expect(harness.calls.inspect).toEqual([]);
        expect(timeline).toContain("router-revalidated");
        expect(harness.calls.routerSetups).toEqual([]);
        expect(harness.calls.routes).toEqual([
          {
            app: "global",
            hostnames: ["mailpit.global.lndo.site"],
          },
        ]);
        expect(harness.events.map((event) => event._tag)).not.toContain("post-global-rebuild");
        const recorded = harness.calls.apply[2]?.options.recordedPlan;
        if (recorded === undefined) throw new Error("expected full recorded plan");
        expect(artifactRefs(recorded)).toEqual(independentGlobalServices.map((name) => `built:${name}`));
      },
      {
        serviceNames: independentGlobalServices,
        failApply: ["ssh-agent"],
        failInspect: true,
        timeline,
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
      const result = await Effect.runPromise(globalStart({}).pipe(Effect.provide(harness.layer)));

      expect(harness.calls.apply).toHaveLength(2);
      expect(harness.calls.build).toHaveLength(2);
      expect(harness.calls.buildOptions).toEqual([undefined, undefined]);
      expect(harness.calls.actions).toEqual(["build", "apply", "build", "apply"]);
      expect(String(harness.calls.apply[0]?.plan.id)).toBe("global");
      expect(harness.calls.apply[0]?.plan.name).toBe("global");
      expect(harness.calls.apply[0]?.plan.root).toBe(AbsolutePath.make(join(harness.dataRoot, "global")));
      expect(harness.calls.apply[0]?.options.reconcile).toBe(false);
      expect(harness.calls.apply[0]?.options.serviceEnvironment?.[ServiceName.make("mail")]).toEqual({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.options.serviceEnvironment?.[ServiceName.make("proxy")]).toEqual({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.plan.services[ServiceName.make("proxy")]?.environment).toEqual({
        LANDO_HOST_IP: "host.lando.internal",
        TOKEN: "${secret:GLOBAL_TOKEN}",
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
        expect(failureOf(exit)).toMatchObject({
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
      expect(result.servicesStarted[0]?.endpoints).toContain("https://mail.global.lndo.site:444");
    });
  });

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
      await materializeDist(harness, {
        proxy: { type: "lando", home: false },
        mail: { type: "lando", home: false },
      });

      const result = await Effect.runPromise(
        globalStatus({ services: ["mail"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(harness.calls.inspect.map((call) => String(call.target.service))).toEqual(["mail"]);
      expect(result.materialized).toBe(true);
      expect(result.services.map((service) => service.service)).toEqual(["mail"]);
      expect(result.services.flatMap((service) => service.endpoints)).toEqual(["https://localhost:8443"]);
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

  test("status returns an empty success when the global app is not installed", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

      expect(harness.calls.inspect).toEqual([]);
      expect(result.materialized).toBe(false);
      expect(result.services).toEqual([]);
    });
  });

  test("status degrades each service to unknown when the provider is unavailable", async () => {
    await withHarness(
      async (harness) => {
        await materializeDist(harness, {
          proxy: { type: "lando", home: false },
          mail: { type: "lando", home: false },
        });

        const result = await Effect.runPromise(globalStatus().pipe(Effect.provide(harness.layer)));

        expect(result.materialized).toBe(true);
        expect(result.services.map((service) => service.service).sort()).toEqual(["mail", "proxy"]);
        expect(result.services.every((service) => service.status === "unknown")).toBe(true);
        expect(result.services.every((service) => service.endpoints.length > 0)).toBe(true);
      },
      { failInspect: true },
    );
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

  test("uninstall rejects plugin arguments before provider or dist mutation", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const exit = await Effect.runPromiseExit(
        globalUninstall({ plugin: "@lando/proxy-traefik" }).pipe(Effect.provide(harness.layer)),
      );
      const failure = failureOf(exit);

      expect(failure).toBeInstanceOf(GlobalAppError);
      expect(harness.calls.destroy).toEqual([]);
      expect((await parseDist(distPath(harness.dataRoot))).services).toHaveProperty("proxy");
    });
  });

  test("uninstall without a plugin regenerates an empty global dist", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(globalUninstall({}).pipe(Effect.provide(harness.layer)));
      const parsed = await parseDist(distPath(harness.dataRoot));

      expect(result.servicesRemoved).toEqual(["proxy"]);
      expect(parsed.services).toEqual({});
      expect(harness.calls.destroy).toEqual([]);
    });
  });

  test("uninstall --purge destroys provider resources before clearing services", async () => {
    await withHarness(async (harness) => {
      await materializeDist(harness);

      const result = await Effect.runPromise(
        globalUninstall({ purge: true }).pipe(Effect.provide(harness.layer)),
      );
      const parsed = await parseDist(distPath(harness.dataRoot));

      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: true, removeState: true });
      expect(result.purged).toBe(true);
      expect(parsed.services).toEqual({});
    });
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
      expect(result.landofile).toEqual(loaded.landofile);
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

      expect(result.services).toEqual([
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
      expect(result.services.every((service) => service.endpoints.length > 0)).toBe(true);
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
      { revalidateStartup: Effect.promise(() => rm(watcherRecordPath())) },
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
      { revalidateStartup: failingWatcherObservation(observedAt) },
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
      { revalidateStartup: failingWatcherObservation(observedAt) },
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
        revalidateStartup: Effect.sync(() => {
          timeline.push("router-revalidated");
        }),
      },
    );
  });

  test("rebuild publishes rebuilt routes and reports route URLs without router setup", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(globalRebuild({}).pipe(Effect.provide(harness.layer)));

      expect(harness.calls.buildOptions).toEqual([{ refresh: true }, { refresh: true }]);

      expect(harness.calls.destroy).toHaveLength(1);
      expect(harness.calls.destroy[0]?.options).toEqual({ volumes: false, removeState: false });
      expect(harness.calls.build).toHaveLength(2);
      expect(harness.calls.apply).toHaveLength(2);
      expect(harness.calls.apply[0]?.options.reconcile).toBe(true);
      expect(harness.calls.apply[0]?.options.serviceEnvironment?.[ServiceName.make("mail")]).toEqual({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.options.serviceEnvironment?.[ServiceName.make("proxy")]).toEqual({
        TOKEN: "resolved-global-token",
      });
      expect(harness.calls.apply[1]?.plan.services[ServiceName.make("proxy")]?.environment).toEqual({
        LANDO_HOST_IP: "host.lando.internal",
        TOKEN: "${secret:GLOBAL_TOKEN}",
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
      expect(result.servicesRebuilt.find((service) => service.name === "mail")?.endpoints).toEqual([
        "https://localhost:8443",
        "https://mail.global.lndo.site:444",
      ]);
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
      expect(result.servicesRebuilt.find((service) => service.name === "mail")?.endpoints).toContain(
        "https://changed.lndo.site:444",
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
        suggestion: "Run lando setup.",
      });
      const layer = Layer.mergeAll(
        harness.layer,
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
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
          reason: "not-running",
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
                chunk: frame.chunk,
                ...(frame.service === undefined ? {} : { service: frame.service }),
              });
            }),
        }),
      );

      const result = await Effect.runPromise(
        followGlobalLogs().pipe(Effect.provide(Layer.mergeAll(harness.layer, sinkLayer))),
      );

      expect(result).toEqual({ app: "global", lines: [] });
      expect(emitted).toEqual([{ service: "proxy", chunk: "ready" }]);
    });
  });
});
