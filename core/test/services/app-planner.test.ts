import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import {
  CapabilityError,
  LandofileValidationError,
  NotImplementedError,
  PluginLoadError,
} from "@lando/core/errors";
import {
  AbsolutePath,
  AppPlan,
  type LandofileShape,
  PluginManifest,
  PluginName,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  PluginRegistry,
  type ServiceTypePlanInput,
  type ServiceTypeShape,
} from "@lando/core/services";
import { CacheServiceLive } from "../../src/cache/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const providerLandoCapabilities: ProviderCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
};

const slowBindMountCapabilities: ProviderCapabilities = {
  ...providerLandoCapabilities,
  bindMountPerformance: "slow",
};

const landofileFixture: LandofileShape = {
  name: "myapp",
  runtime: 4,
  services: {
    [ServiceName.make("web")]: {
      image: "node:lts",
      ports: ["3000:3000"],
      environment: { NODE_ENV: "development" },
      dependsOn: ["db"],
    },
    [ServiceName.make("db")]: {
      image: "postgres:16",
      ports: ["5432:5432"],
      environment: { POSTGRES_PASSWORD: "lando" },
    },
  },
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-app-planner-")));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const plan = (landofile: LandofileShape, providerCapabilities = providerLandoCapabilities) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

const planExit = (landofile: LandofileShape, providerCapabilities = providerLandoCapabilities) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

const appMountOnlyServiceType: ServiceTypeShape = {
  id: "appmount-only",
  toServicePlan: ({
    name,
    appRoot,
    provider = ProviderId.make("lando"),
    primary = false,
    metadata,
  }: ServiceTypePlanInput) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "appmount-only",
      provider,
      primary,
      artifact: { kind: "ref", ref: "appmount-only:latest" },
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
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
};

const socketOnlyServiceType: ServiceTypeShape = {
  id: "socket-only",
  toServicePlan: ({
    name,
    provider = ProviderId.make("lando"),
    primary = false,
    metadata,
  }: ServiceTypePlanInput) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "socket-only",
      provider,
      primary,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [{ protocol: "unix", socketPath: PortablePath.make("/var/run/socket-only.sock"), name }],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
};

const customPluginRegistry = {
  list: Effect.succeed([]),
  load: (pluginName: string) =>
    Effect.fail(new PluginLoadError({ message: `Plugin ${pluginName} is not registered.`, pluginName })),
  loadServiceType: (id: string) => {
    if (id === appMountOnlyServiceType.id) return Effect.succeed(appMountOnlyServiceType);
    if (id === socketOnlyServiceType.id) return Effect.succeed(socketOnlyServiceType);
    return Effect.fail(
      new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
    );
  },
};

const planWithCustomRegistry = (
  landofile: LandofileShape,
  providerCapabilities = providerLandoCapabilities,
) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(Layer.succeed(PluginRegistry, customPluginRegistry)),
    ),
  );

const planExitWithCustomRegistry = (
  landofile: LandofileShape,
  providerCapabilities = providerLandoCapabilities,
) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(Layer.succeed(PluginRegistry, customPluginRegistry)),
    ),
  );

const expectSomeFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") {
      throw new Error("Expected Some failure");
    }

    return failure.value;
  }

  throw new Error("Expected failure");
};

describe("AppPlannerLive", () => {
  test("reuses the persisted app plan cache until planning inputs change", async () => {
    await withTempCwd(async () => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-plan-cache-root-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      let servicePlanCalls = 0;
      const cachedType: ServiceTypeShape = {
        id: "cached-type",
        toServicePlan: ({
          name,
          appRoot,
          provider = ProviderId.make("lando"),
          primary = false,
          metadata,
        }) => {
          servicePlanCalls += 1;
          return Schema.decodeUnknownSync(ServicePlan)({
            name: ServiceName.make(name),
            type: "cached-type",
            provider,
            primary,
            artifact: { kind: "ref", ref: "cached-type:latest" },
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
            endpoints: [],
            routes: [],
            dependsOn: [],
            hostAliases: [],
            metadata,
            extensions: {},
          });
        },
      };
      const layer = AppPlannerLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            CacheServiceLive,
            Layer.succeed(PluginRegistry, {
              list: Effect.succeed([
                Schema.decodeUnknownSync(PluginManifest)({
                  name: PluginName.make("@lando/cached"),
                  version: "1.0.0",
                  api: 4 as const,
                  contributes: { serviceTypes: ["cached-type"] },
                }),
              ]),
              load: () => Effect.die("not needed"),
              loadServiceType: () => Effect.succeed(cachedType),
            }),
          ),
        ),
      );
      const cachedLandofile: LandofileShape = {
        name: "cached-app",
        services: { [ServiceName.make("web")]: { type: "cached-type" } },
      };

      try {
        const runPlan = (landofile: LandofileShape) =>
          Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
              Effect.provide(layer),
            ),
          );

        const first = await runPlan(cachedLandofile);
        const second = await runPlan(cachedLandofile);
        const changed = await runPlan({
          ...cachedLandofile,
          services: {
            [ServiceName.make("web")]: {
              type: "cached-type",
              environment: { CACHE_BUSTER: "1" },
            },
          },
        });

        expect(first.name).toBe("cached-app");
        expect(second.metadata.resolvedAt).toEqual(first.metadata.resolvedAt);
        expect(changed.name).toBe("cached-app");
        expect(servicePlanCalls).toBe(2);
      } finally {
        if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  test("plans a Node and Postgres Landofile into a schema-valid AppPlan", async () => {
    await withTempCwd(async (appRoot) => {
      const appPlan = await plan(landofileFixture);

      const encoded = Schema.encodeSync(AppPlan)(appPlan);
      expect(Schema.decodeUnknownEither(AppPlan)(encoded)._tag).toBe("Right");
      expect(appPlan.provider).toBe(ProviderId.make("lando"));
      expect(Object.keys(appPlan.services).sort()).toEqual(["db", "web"]);

      const web = appPlan.services[ServiceName.make("web")];
      const db = appPlan.services[ServiceName.make("db")];

      expect(web?.type).toBe("node:lts");
      expect(web?.artifact).toEqual({ kind: "ref", ref: "node:lts" });
      expect(web?.environment).toMatchObject({ NODE_ENV: "development" });
      expect(String(web?.workingDirectory)).toBe("/app");
      expect(web?.mounts).toContainEqual({
        type: "bind",
        source: appRoot,
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "passthrough",
      });
      expect(web?.endpoints).toEqual([{ port: 3000, protocol: "http", name: "web" }]);
      expect(web?.dependsOn).toEqual([{ service: ServiceName.make("db"), condition: "started" }]);

      expect(db?.type).toBe("postgres");
      expect(db?.artifact).toEqual({ kind: "ref", ref: "postgres:16" });
      expect(db?.environment.POSTGRES_USER).toBe("lando");
      expect(db?.environment.POSTGRES_DB).toBe("myapp");
      expect(db?.environment.POSTGRES_PASSWORD).toBe("lando");
      expect(db?.endpoints).toEqual([{ port: 5432, protocol: "tcp", name: "db" }]);
      expect(db?.storage[0]?.target).toBe(PortablePath.make("/var/lib/postgresql/data"));
    });
  });

  test("resolves type: node:22 and image: node:22-alpine to the node:22 ServiceType", async () => {
    await withTempCwd(async (appRoot) => {
      const appPlan = await plan({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: { type: "node:22" },
          [ServiceName.make("worker")]: { image: "node:22-alpine" },
        },
      });

      const web = appPlan.services[ServiceName.make("web")];
      const worker = appPlan.services[ServiceName.make("worker")];

      expect(web?.type).toBe("node:22");
      expect(web?.artifact).toEqual({ kind: "ref", ref: "node:22" });
      expect(String(web?.workingDirectory)).toBe("/app");
      expect(web?.mounts).toContainEqual({
        type: "bind",
        source: appRoot,
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "passthrough",
      });

      expect(worker?.type).toBe("node:22");
      expect(worker?.artifact).toEqual({ kind: "ref", ref: "node:22-alpine" });
    });
  });

  test("marks slow provider bind mounts as accelerated", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(landofileFixture, slowBindMountCapabilities);
      const web = appPlan.services[ServiceName.make("web")];

      expect(web?.appMount?.realization).toBe("accelerated");
      expect(web?.mounts).toContainEqual({
        type: "bind",
        source: process.cwd(),
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "accelerated",
      });
      expect(web?.mounts.some((mount) => mount.type === "volume")).toBe(false);
    });
  });

  test("fails unknown service types with LandofileValidationError", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("cache")]: {
            type: "totally-not-a-service",
            image: "redis:7",
          },
        },
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(failure._tag).toBe("LandofileValidationError");
      if (failure instanceof LandofileValidationError) {
        expect(failure.issues).toEqual(["services.cache.type"]);
      }
    });
  });

  test("fails before apply when a planned service requires an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(landofileFixture, {
        ...providerLandoCapabilities,
        bindMounts: false,
        bindMountPerformance: "none",
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      expect(failure).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        feature: "bind mount",
        capability: "bindMounts",
        providerId: "lando",
        remediation: "Choose a provider with bind mount support or remove bind mounts from service web.",
      });
    });
  });

  test("fails before apply when published ports require an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(landofileFixture, {
        ...providerLandoCapabilities,
        hostPortPublish: "none",
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure._tag).toBe("CapabilityError");
        expect(failure.service).toBe("web");
        expect(failure.feature).toBe("host port publish");
        expect(failure.capability).toBe("hostPortPublish");
        expect(failure.providerId).toBe("lando");
        expect(failure.remediation).toBe(
          "Choose a provider with host port publish support or remove published ports from service web.",
        );
      }
    });
  });

  test("does not require host port publishing for unix-socket endpoints", async () => {
    await withTempCwd(async () => {
      const appPlan = await planWithCustomRegistry(
        {
          name: "socketapp",
          runtime: 4,
          services: {
            [ServiceName.make("socket")]: { type: "socket-only" },
          },
        },
        { ...providerLandoCapabilities, hostPortPublish: "none" },
      );

      const socket = appPlan.services[ServiceName.make("socket")];
      expect(socket?.endpoints).toEqual([
        {
          protocol: "unix",
          socketPath: PortablePath.make("/var/run/socket-only.sock"),
          name: "socket",
        },
      ]);
    });
  });

  test("fails before apply when appMount requires an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const exit = await planExitWithCustomRegistry(
        {
          name: "appmountapp",
          runtime: 4,
          services: {
            [ServiceName.make("web")]: { type: "appmount-only" },
          },
        },
        {
          ...providerLandoCapabilities,
          bindMounts: false,
          bindMountPerformance: "none",
        },
      );

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure._tag).toBe("CapabilityError");
        expect(failure.service).toBe("web");
        expect(failure.feature).toBe("bind mount");
        expect(failure.capability).toBe("bindMounts");
        expect(failure.providerId).toBe("lando");
        expect(failure.remediation).toBe(
          "Choose a provider with bind mount support or remove bind mounts from service web.",
        );
      }
    });
  });

  test("aggregates per-service storage mounts into AppPlan.stores with default service scope", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "stockapp",
        runtime: 4,
        services: {
          [ServiceName.make("db")]: { type: "postgres" },
          [ServiceName.make("cache")]: { type: "redis" },
        },
      });

      expect(appPlan.stores).toHaveLength(2);
      expect(appPlan.stores.every((s) => s.scope === "service")).toBe(true);
      const postgresMount = appPlan.services[ServiceName.make("db")]?.storage[0]?.store;
      const redisMount = appPlan.services[ServiceName.make("cache")]?.storage[0]?.store;
      expect(postgresMount).toBeDefined();
      expect(redisMount).toBeDefined();
      const storeNames = appPlan.stores.map((s) => s.name).sort();
      expect(storeNames).toEqual([postgresMount ?? "", redisMount ?? ""].sort());
    });
  });

  test("aggregates compose-declared named volumes into AppPlan.stores so destroy can preserve them", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "composeapp",
        runtime: 4,
        services: {
          [ServiceName.make("worker")]: {
            type: "compose",
            image: "alpine:3",
            volumes: ["worker-state:/var/state", "worker-cache:/var/cache"],
          },
        },
      });

      const storeNames = appPlan.stores.map((s) => s.name).sort();
      expect(storeNames).toEqual(["composeapp-worker-cache", "composeapp-worker-state"]);
      expect(appPlan.stores.every((s) => s.scope === "service")).toBe(true);
    });
  });

  test("fails before apply when service storage requires an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(landofileFixture, {
        ...providerLandoCapabilities,
        persistentStorage: false,
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure._tag).toBe("CapabilityError");
        expect(failure.service).toBe("db");
        expect(failure.feature).toBe("persistent storage");
        expect(failure.capability).toBe("persistentStorage");
        expect(failure.providerId).toBe("lando");
        expect(failure.remediation).toBe(
          "Choose a provider with persistent storage support or remove persistent storage from service db.",
        );
      }
    });
  });

  test("rejects storage scope: global with NotImplementedError until the global app phase", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "globalapp",
        runtime: 4,
        services: {
          [ServiceName.make("worker")]: {
            type: "compose",
            image: "alpine:3",
            storage: [
              {
                store: "cross-app-cache",
                target: "/cache",
                scope: "global",
              },
            ],
          },
        },
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(NotImplementedError);
      if (failure instanceof NotImplementedError) {
        expect(failure._tag).toBe("NotImplementedError");
        expect(failure.specSection).toBe("§6.5");
        expect(failure.message).toContain("worker");
        expect(failure.message.toLowerCase()).toContain("global");
        expect(failure.remediation.toLowerCase()).toContain("global");
      }
    });
  });

  test("expands appMount.excludes into volume-shadow stores in AppPlan.stores", async () => {
    await withTempCwd(async () => {
      const appPlan = await planWithCustomRegistry({
        name: "shadowapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            type: "appmount-only",
            appMount: {
              target: "/app",
              excludes: ["node_modules", "vendor"],
            },
          },
        },
      });

      const storeNames = appPlan.stores.map((s) => s.name).sort();
      expect(storeNames).toEqual(["shadowapp-web-app-node-modules", "shadowapp-web-app-vendor"]);
      expect(appPlan.stores.every((s) => s.scope === "service")).toBe(true);

      const web = appPlan.services[ServiceName.make("web")];
      const shadowTargets = web?.storage.map((entry) => entry.target).sort() ?? [];
      expect(shadowTargets).toEqual([
        PortablePath.make("/app/node_modules"),
        PortablePath.make("/app/vendor"),
      ]);
      expect(web?.appMount?.excludes).toEqual([
        PortablePath.make("node_modules"),
        PortablePath.make("vendor"),
      ]);
    });
  });

  test("emits a per-app bridge network for multi-service apps", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(landofileFixture);

      expect(appPlan.networks).toEqual([{ name: "lando-myapp", shared: false, driver: "bridge" }]);
    });
  });

  test("emits a per-app bridge network for single-service apps and slugifies the network name", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "my app",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: { type: "node:22" },
        },
      });

      expect(appPlan.networks).toEqual([{ name: "lando-my-app", shared: false, driver: "bridge" }]);
    });
  });

  test("omits networks when the app declares no services", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "emptyapp",
        runtime: 4,
        services: {},
      });

      expect(appPlan.networks).toEqual([]);
    });
  });

  test("rejects healthcheck kind: tcp with a CapabilityError citing serviceHealth", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            image: "node:lts",
            healthcheck: {
              kind: "tcp",
              port: 3000,
              intervalSeconds: 10,
              timeoutSeconds: 5,
              retries: 5,
            },
          },
        },
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure.service).toBe("web");
        expect(failure.feature).toBe("healthcheck kind tcp");
        expect(failure.capability).toBe("serviceHealth");
        expect(failure.providerId).toBe("lando");
        expect(failure.remediation).toContain("kind: command");
      }
    });
  });

  test("rejects healthcheck kind: http with a CapabilityError citing serviceHealth", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            image: "node:lts",
            healthcheck: {
              kind: "http",
              url: "http://localhost:3000/health",
              intervalSeconds: 10,
              timeoutSeconds: 5,
              retries: 5,
            },
          },
        },
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure.service).toBe("web");
        expect(failure.feature).toBe("healthcheck kind http");
        expect(failure.capability).toBe("serviceHealth");
        expect(failure.providerId).toBe("lando");
        expect(failure.remediation).toContain("kind: command");
      }
    });
  });

  test("drops partial healthcheck override on a service type with no default rather than producing a commandless plan", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("db")]: {
            image: "node:lts",
            healthcheck: {
              intervalSeconds: 30,
            },
          },
        },
      });
      expect(appPlan.services[ServiceName.make("db")]?.healthcheck).toBeUndefined();
    });
  });
});
