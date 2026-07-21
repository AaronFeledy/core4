import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";

import { GlobalServiceMissingError } from "@lando/core/errors";
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
  type AppPlanResolver,
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
  type ServiceSelector,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";

import { CacheServiceLive } from "../../src/cache/service.ts";
import {
  ensureGlobalServicesRunning,
  requiredGlobalServicesForPlan,
} from "../../src/cli/commands/meta/ensure-global-services.ts";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { AppPlanResolverLive } from "../../src/services/app-plan-resolver.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

interface ApplyCall {
  readonly plan: AppPlan;
  readonly options: ApplyOptions;
}

interface InspectCall {
  readonly target: ServiceSelector;
}

interface Harness {
  readonly dataRoot: string;
  readonly layer: Layer.Layer<
    | AppPlanner
    | AppPlanResolver
    | BuildOrchestrator
    | CacheService
    | ConfigService
    | EventService
    | FileSystem
    | GlobalAppService
    | PluginRegistry
    | RuntimeProviderRegistry
  >;
  readonly applyCalls: Array<ApplyCall>;
  readonly buildCalls: Array<AppPlan>;
  readonly inspectCalls: Array<InspectCall>;
  readonly events: Array<LandoEvent>;
}

const providerId = ProviderId.make("lando");

const withTempRoots = async <T>(run: (dataRoot: string) => Promise<T>): Promise<T> => {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-ensure-global-data-")));
  const confRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-ensure-global-conf-")));
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  try {
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.LANDO_USER_CONF_ROOT = confRoot;
    return await run(dataRoot);
  } finally {
    if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    if (previousConf === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
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
      environment: {},
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
      endpoints: [{ protocol: "http", port: 8080, name: "http" }],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
});

const writeGlobalServiceModule = async (moduleRoot: string): Promise<string> => {
  const modulePath = join(moduleRoot, "fake-global-service.mjs");
  await Bun.write(
    modulePath,
    'import { Effect } from "effect";\nexport default Effect.succeed({ type: "lando" });\n',
  );
  return modulePath;
};

const makeHarness = async (
  dataRoot: string,
  moduleRoot: string,
  serviceIds: ReadonlyArray<string> = ["traefik"],
): Promise<Harness> => {
  const modulePath = await writeGlobalServiceModule(moduleRoot);
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@lando/fake-global-ensure",
    version: "1.0.0",
    api: 4,
    contributes: {
      serviceTypes: [fakeServiceType.id],
      globalServices: serviceIds.map((id) => ({ id, module: modulePath, enabledByDefault: true })),
    },
  });
  const applyCalls: Array<ApplyCall> = [];
  const buildCalls: Array<AppPlan> = [];
  const inspectCalls: Array<InspectCall> = [];
  const events: Array<LandoEvent> = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: String(providerId),
    capabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
    apply: (plan, options) =>
      Effect.sync(() => {
        applyCalls.push({ plan, options });
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
        endpoints: [{ protocol: "http", port: 8080, name: "http" }],
      });
    },
  };
  const pluginRegistry = {
    list: Effect.succeed([manifest]),
    load: () => Effect.succeed(manifest),
    loadServiceType: () => Effect.succeed(fakeServiceType),
    loadServiceFeature: (id: string) =>
      id === fakeServiceType.testFeature.id
        ? Effect.succeed(fakeServiceType.testFeature)
        : Effect.die(`unexpected service feature ${id}`),
    loadAppFeature: () => Effect.die("not used"),
  };
  const buildOrchestrator = {
    build: (plan: AppPlan) =>
      Effect.sync(() => {
        buildCalls.push(plan);
        return {
          ...plan,
          services: Object.fromEntries(
            Object.entries(plan.services).map(([id, service]) => [
              id,
              { ...service, artifact: { kind: "ref" as const, ref: `built:${String(service.name)}` } },
            ]),
          ),
        };
      }),
    buildApp: () => Effect.void,
  };
  const globalAppLive = GlobalAppServiceLive.pipe(
    Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive)),
  );
  const plannerLive = AppPlannerLive.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(PluginRegistry, pluginRegistry), CacheServiceLive, ConfigServiceLive),
    ),
  );
  const resolverLive = AppPlanResolverLive.pipe(
    Layer.provide(Layer.mergeAll(FileSystemLive, globalAppLive, plannerLive)),
  );
  const layer = Layer.mergeAll(
    ConfigServiceLive,
    CacheServiceLive,
    FileSystemLive,
    globalAppLive,
    Layer.succeed(EventService, {
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
    Layer.succeed(PluginRegistry, pluginRegistry),
    Layer.succeed(BuildOrchestrator, buildOrchestrator),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
    plannerLive,
    resolverLive,
  );
  return { dataRoot, layer, applyCalls, buildCalls, inspectCalls, events };
};

const withHarness = async <T>(
  run: (harness: Harness) => Promise<T>,
  serviceIds?: ReadonlyArray<string>,
): Promise<T> =>
  withTempRoots(async (dataRoot) => {
    const moduleRoot = await realpath(await mkdtemp(join(process.cwd(), ".lando-ensure-global-module-")));
    try {
      const harness = await makeHarness(dataRoot, moduleRoot, serviceIds);
      return await run(harness);
    } finally {
      await rm(moduleRoot, { recursive: true, force: true });
    }
  });

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("ensureGlobalServicesRunning", () => {
  test("reads required global services from AppPlan.requires", () => {
    expect(requiredGlobalServicesForPlan({ requires: { globalServices: ["traefik"] } })).toEqual(["traefik"]);
    expect(requiredGlobalServicesForPlan({})).toEqual([]);
  });

  test("cold ensure publishes pre/post-global-start and applies the selected global service", async () => {
    await withHarness(async (harness) => {
      const result = await Effect.runPromise(
        ensureGlobalServicesRunning({ services: ["traefik"] }).pipe(Effect.provide(harness.layer)),
      );

      expect(result.app).toBe("global");
      expect(result.servicesStarted.map((service) => service.name)).toEqual(["traefik"]);
      expect(harness.buildCalls).toHaveLength(1);
      expect(Object.keys(harness.buildCalls[0]?.services ?? {})).toEqual(["traefik"]);
      expect(harness.applyCalls).toHaveLength(1);
      expect(String(harness.applyCalls[0]?.plan.id)).toBe("global");
      expect(Object.keys(harness.applyCalls[0]?.plan.services ?? {})).toEqual(["traefik"]);
      expect(harness.applyCalls[0]?.plan.services[ServiceName.make("traefik")]?.artifact).toEqual({
        kind: "ref",
        ref: "built:traefik",
      });
      expect(harness.applyCalls[0]?.options.reconcile).toBe(false);
      expect(harness.inspectCalls.map((call) => String(call.target.service))).toEqual(["traefik"]);

      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-start" || event._tag === "post-global-start",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-start", "post-global-start"]);
      const pre = lifecycle[0] as {
        readonly triggeredBy?: string;
        readonly ensuringServices?: ReadonlyArray<string>;
        readonly cached?: boolean;
      };
      expect(pre.triggeredBy).toBe("ensure-running");
      expect(pre.ensuringServices).toEqual(["traefik"]);
      expect(pre.cached).toBe(false);
      expect((lifecycle[1] as { readonly cached?: boolean }).cached).toBe(false);
    });
  });

  test("missing requested services publish pre-global-start and fail without post-global-start", async () => {
    await withHarness(async (harness) => {
      const exit = await Effect.runPromiseExit(
        ensureGlobalServicesRunning({ services: ["mailpit"] }).pipe(Effect.provide(harness.layer)),
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(GlobalServiceMissingError);
      if (error instanceof GlobalServiceMissingError) {
        expect(error.requested).toEqual(["mailpit"]);
        expect(error.available).toEqual(["traefik"]);
        expect(error.message).toBe("Global service(s) not available in the global app: mailpit.");
        expect("missing" in error).toBe(false);
      }
      expect(harness.buildCalls).toEqual([]);
      expect(harness.applyCalls).toEqual([]);
      expect(harness.inspectCalls).toEqual([]);
      const lifecycle = harness.events.filter(
        (event) => event._tag === "pre-global-start" || event._tag === "post-global-start",
      );
      expect(lifecycle.map((event) => event._tag)).toEqual(["pre-global-start"]);
      expect((lifecycle[0] as { readonly triggeredBy?: string }).triggeredBy).toBe("ensure-running");
    });
  });
});
