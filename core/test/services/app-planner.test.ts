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
import { AppPlanner, ConfigService, PluginRegistry } from "@lando/core/services";
import type { AppFeatureDefinition, ServiceFeatureDefinition, ServiceType } from "@lando/core/services";

import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive, FILE_SYNC_DEFAULT_EXCLUDES } from "../../src/services/planner.ts";

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
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
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

const configLayer = (defaultProviderId: ProviderId | null) => {
  const config = { defaultProviderId, telemetry: { enabled: false } };
  const load = Effect.succeed(config);
  return Layer.succeed(ConfigService, {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  });
};

const planWithConfig = (
  landofile: LandofileShape,
  defaultProviderId: ProviderId | null,
  providerCapabilities = providerLandoCapabilities,
) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (appPlanner) => appPlanner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
      Effect.provide(configLayer(defaultProviderId)),
    ),
  );

const appMountOnlyServiceType = makeLegacyServiceTypeFake({
  id: "appmount-only",
  toServicePlan: ({ name, appRoot, provider = ProviderId.make("lando"), primary = false, metadata }) =>
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
});

const socketOnlyServiceType = makeLegacyServiceTypeFake({
  id: "socket-only",
  toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) =>
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
});

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
  loadServiceFeature: (id: string) =>
    Effect.fail(new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id })),
  loadAppFeature: (id: string) =>
    Effect.fail(new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id })),
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
  if (!Exit.isFailure(exit)) {
    throw new Error("Expected failure");
  }

  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  return failure.value;
};

describe("AppPlannerLive", () => {
  test("uses LANDO_PROVIDER when the Landofile does not set provider", async () => {
    const previous = process.env.LANDO_PROVIDER;
    process.env.LANDO_PROVIDER = "docker";
    try {
      const appPlan = await plan(landofileFixture);
      expect(String(appPlan.provider)).toBe("docker");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      else process.env.LANDO_PROVIDER = previous;
    }
  });

  test("uses config defaultProviderId when no Landofile or env provider is set", async () => {
    const previous = process.env.LANDO_PROVIDER;
    Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
    try {
      const appPlan = await planWithConfig(landofileFixture, ProviderId.make("docker"));
      expect(String(appPlan.provider)).toBe("docker");
    } finally {
      if (previous !== undefined) process.env.LANDO_PROVIDER = previous;
    }
  });

  test("Landofile provider wins over env and config defaults", async () => {
    const previous = process.env.LANDO_PROVIDER;
    process.env.LANDO_PROVIDER = "docker";
    try {
      const appPlan = await planWithConfig(
        { ...landofileFixture, provider: ProviderId.make("podman") },
        ProviderId.make("lando"),
      );
      expect(String(appPlan.provider)).toBe("podman");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      else process.env.LANDO_PROVIDER = previous;
    }
  });

  test("adds configured service hostnames to shared networking aliases", async () => {
    const appPlan = await plan({
      ...landofileFixture,
      services: {
        [ServiceName.make("mailpit")]: {
          type: "compose",
          image: "docker.io/axllent/mailpit:v1.30.1",
          appMount: false,
          hostnames: ["mailpit.global.internal"],
        },
      },
    });

    expect(appPlan.networking?.sharedNetworkMembership?.aliases[ServiceName.make("mailpit")]).toEqual([
      "mailpit.myapp.internal",
      "mailpit.global.internal",
    ]);
  });

  test("suppresses per-app Mailpit env vars for global app services", async () => {
    const appPlan = await plan({
      name: "global",
      runtime: 4,
      services: {
        [ServiceName.make("mailpit")]: {
          type: "compose",
          image: "docker.io/axllent/mailpit:v1.30.1",
          appMount: false,
        },
      },
    });

    const mailpit = appPlan.services[ServiceName.make("mailpit")];
    expect(mailpit?.environment.LANDO_APP_KIND).toBe("global");
    expect(mailpit?.environment.LANDO_MAIL_HOST).toBeUndefined();
    expect(mailpit?.environment.LANDO_MAIL_PORT).toBeUndefined();
  });

  test("reuses the persisted app plan cache until planning inputs change", async () => {
    await withTempCwd(async () => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-plan-cache-root-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      let servicePlanCalls = 0;
      const cachedType = makeLegacyServiceTypeFake({
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
      });
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
              loadServiceFeature: () => Effect.die("not used"),
              loadAppFeature: () => Effect.die("not used"),
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

  test("marks routed apps as requiring the global traefik service", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(landofileFixture);

      expect(appPlan.routes).not.toEqual([]);
      expect(appPlan.requires?.globalServices).toEqual(["traefik"]);
    });
  });

  test("omits global service requirements when the plan has no routes", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("worker")]: {
            image: "node:lts",
            ports: [],
          },
        },
      });

      expect(appPlan.routes).toEqual([]);
      expect(appPlan.requires).toBeUndefined();
    });
  });

  test("loads manifest app-features, mutates selected drafts, and aggregates required global services", async () => {
    await withTempCwd(async () => {
      const featureDefinition: AppFeatureDefinition = {
        id: "test.smtp",
        priority: 100,
        activatedBy: { services: { type: "appmount-only" } },
        selectors: { types: ["appmount-only"] },
        requires: { globalServices: ["mailpit"] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) => service.addEnv("MAIL_HOST", "mailpit.global.internal"));
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/app-feature"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { appFeatures: ["test.smtp"] },
          }),
        ]),
        loadAppFeature: (id: string) =>
          id === "test.smtp"
            ? Effect.succeed(featureDefinition)
            : Effect.fail(
                new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: "appmount-only" } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.environment.MAIL_HOST).toBe(
        "mailpit.global.internal",
      );
      expect(appPlan.requires?.globalServices).toEqual(["mailpit"]);
    });
  });

  test("fails with CapabilityError when an activated app feature requires an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const featureDefinition: AppFeatureDefinition = {
        id: "test.needs-shared-network",
        priority: 100,
        activatedBy: { services: { type: "appmount-only" } },
        selectors: { types: ["appmount-only"] },
        requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) => service.addEnv("NEEDS_SHARED", "1"));
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/app-feature-caps"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { appFeatures: [featureDefinition.id] },
          }),
        ]),
        loadAppFeature: (id: string) =>
          id === featureDefinition.id
            ? Effect.succeed(featureDefinition)
            : Effect.fail(
                new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: "appmount-only" } },
            },
            { ...providerLandoCapabilities, sharedCrossAppNetwork: false },
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(CapabilityError);
          const error = failure.value as CapabilityError;
          expect(error.capability).toBe("sharedCrossAppNetwork");
          expect(error.feature).toBe("test.needs-shared-network");
        }
      }
    });
  });

  test("passes resolved service feature ids into app-feature activation", async () => {
    await withTempCwd(async () => {
      const serviceFeature: ServiceFeatureDefinition = {
        id: "test.service-feature",
        priority: 100,
        apply: (ctx) => Effect.sync(() => ctx.addEnv("SERVICE_FEATURE_COMPOSED", "1")),
      };
      const serviceType: ServiceType = {
        id: "feature-backed",
        name: "feature-backed",
        base: "lando",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "lando" as const,
            normalizedConfig: input.service,
            features: [{ id: "test.service-feature" }],
          }),
      };
      const featureDefinition: AppFeatureDefinition = {
        id: "test.feature-aware",
        priority: 100,
        activatedBy: { services: { hasFeature: "test.service-feature" } },
        selectors: { hasFeature: ["test.service-feature"] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) => service.addEnv("FEATURE_AWARE", "1"));
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/feature-aware"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [serviceType.id], appFeatures: [featureDefinition.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadServiceFeature: (id: string) =>
          id === serviceFeature.id
            ? Effect.succeed(serviceFeature)
            : Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              ),
        loadAppFeature: (id: string) =>
          id === featureDefinition.id
            ? Effect.succeed(featureDefinition)
            : Effect.fail(
                new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: serviceType.id } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.environment.SERVICE_FEATURE_COMPOSED).toBe("1");
      expect(appPlan.services[ServiceName.make("web")]?.environment.FEATURE_AWARE).toBe("1");
    });
  });

  test("preserves service routes across the app-feature draft round-trip", async () => {
    await withTempCwd(async () => {
      const routedServiceType = makeLegacyServiceTypeFake({
        id: "routed",
        toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) =>
          Schema.decodeUnknownSync(ServicePlan)({
            name: ServiceName.make(name),
            type: "routed",
            provider,
            primary,
            environment: {},
            mounts: [],
            storage: [],
            endpoints: [],
            routes: [{ index: 7 }],
            dependsOn: [],
            hostAliases: [],
            metadata,
            extensions: {},
          }),
      });
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/routed"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [routedServiceType.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === routedServiceType.id
            ? Effect.succeed(routedServiceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: routedServiceType.id } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.routes).toEqual([{ index: 7 }]);
    });
  });

  test("preserves existing service-feature build steps when app-features add build steps", async () => {
    await withTempCwd(async () => {
      const buildStepServiceType = makeLegacyServiceTypeFake({
        id: "build-step-backed",
        toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) =>
          Schema.decodeUnknownSync(ServicePlan)({
            name: ServiceName.make(name),
            type: "build-step-backed",
            provider,
            primary,
            environment: {},
            mounts: [],
            storage: [],
            endpoints: [],
            routes: [],
            dependsOn: [],
            hostAliases: [],
            metadata,
            extensions: {
              "@lando/core/service-features": {
                source: "service-feature",
                buildSteps: [{ id: "base-install", phase: "build", command: ["bun", "install"] }],
              },
            },
          }),
      });
      const featureDefinition: AppFeatureDefinition = {
        id: "test.add-build-step",
        priority: 100,
        selectors: { types: [buildStepServiceType.id] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) =>
              service.addBuildStep({
                id: "app-feature-build",
                phase: "postbuild",
                command: ["bun", "run", "build"],
                dependsOn: ["base-install"],
              }),
            );
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/build-steps"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [buildStepServiceType.id], appFeatures: [featureDefinition.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === buildStepServiceType.id
            ? Effect.succeed(buildStepServiceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadAppFeature: (id: string) =>
          id === featureDefinition.id
            ? Effect.succeed(featureDefinition)
            : Effect.fail(
                new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: buildStepServiceType.id } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.extensions["@lando/core/service-features"]).toEqual({
        source: "service-feature",
        buildSteps: [
          { id: "base-install", phase: "build", command: ["bun", "install"] },
          {
            id: "app-feature-build",
            phase: "postbuild",
            command: ["bun", "run", "build"],
            dependsOn: ["base-install"],
          },
        ],
      });
    });
  });

  test("deduplicates manifest app-feature ids before applying", async () => {
    await withTempCwd(async () => {
      let applyCalls = 0;
      const featureDefinition: AppFeatureDefinition = {
        id: "test.once",
        priority: 100,
        selectors: { types: ["appmount-only"] },
        apply: (ctx) =>
          Effect.sync(() => {
            applyCalls += 1;
            ctx.forEachSelected((service) => service.addEnv("ONCE", "1"));
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/app-feature-a"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { appFeatures: [featureDefinition.id, featureDefinition.id] },
          }),
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/app-feature-b"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { appFeatures: [featureDefinition.id] },
          }),
        ]),
        loadAppFeature: (id: string) =>
          id === featureDefinition.id
            ? Effect.succeed(featureDefinition)
            : Effect.fail(
                new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: "appmount-only" } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.environment.ONCE).toBe("1");
      expect(applyCalls).toBe(1);
    });
  });

  test("inactive manifest app-features do not mutate services or add global requirements", async () => {
    await withTempCwd(async () => {
      const featureDefinition: AppFeatureDefinition = {
        id: "test.php-only",
        priority: 100,
        activatedBy: { services: { type: "php" } },
        selectors: { types: ["appmount-only"] },
        requires: { globalServices: ["mailpit"] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) => service.addEnv("MAIL_HOST", "mailpit.global.internal"));
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/app-feature"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { appFeatures: ["test.php-only"] },
          }),
        ]),
        loadAppFeature: (id: string) =>
          id === "test.php-only"
            ? Effect.succeed(featureDefinition)
            : Effect.fail(
                new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: "appmount-only" } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.environment.MAIL_HOST).toBeUndefined();
      expect(appPlan.requires).toBeUndefined();
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

  test("emits one mutagen FileSyncPlan entry per service with an accelerated appMount", async () => {
    await withTempCwd(async (dir) => {
      const appPlan = await plan(landofileFixture, slowBindMountCapabilities);

      expect(appPlan.fileSync).toHaveLength(1);
      expect(appPlan.fileSync.every((entry) => entry.engineId === "mutagen")).toBe(true);
      expect(
        appPlan.fileSync.map((entry) => `${entry.session.service}:${entry.session.mountKey}`).sort(),
      ).toEqual(["web:app-mount"]);

      const webEntry = appPlan.fileSync.find((entry) => entry.session.service === ServiceName.make("web"));
      expect(webEntry).toBeDefined();
      expect(webEntry?.session.app).toEqual({
        kind: "user",
        id: appPlan.id,
        root: AbsolutePath.make(dir),
      });
      expect(webEntry?.session.mountKey).toBe("app-mount");
      expect(webEntry?.session.source).toBe(AbsolutePath.make(dir));
      expect(webEntry?.session.mode).toBe("two-way-safe");
      expect(webEntry?.session.target).toEqual({
        _tag: "volume",
        name: "myapp-web-app-mount",
        path: PortablePath.make("/app"),
      });
    });
  });

  test("emits an empty FileSyncPlan list on native bind-mount providers", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(landofileFixture, providerLandoCapabilities);
      expect(appPlan.fileSync).toEqual([]);
    });
  });

  test("resolves the file-sync engine id once per plan for all slow bind-mount services", async () => {
    await withTempCwd(async () => {
      let fileSyncEngineIdReads = 0;
      const serviceType = makeLegacyServiceTypeFake({
        id: "accelerated-appmount",
        toServicePlan: ({ name, appRoot, provider = ProviderId.make("lando"), primary = false, metadata }) =>
          Schema.decodeUnknownSync(ServicePlan)({
            name: ServiceName.make(name),
            type: "accelerated-appmount",
            provider,
            primary,
            artifact: { kind: "ref", ref: "accelerated-appmount:latest" },
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
      });
      const registry = {
        list: Effect.succeed([
          {
            name: PluginName.make("@lando/slow-bind"),
            version: "1.0.0",
            api: 4 as const,
            contributes: {
              serviceTypes: [serviceType.id],
              get fileSyncEngines() {
                fileSyncEngineIdReads += 1;
                return ["mutagen"];
              },
            },
          } as unknown as PluginManifest,
        ]),
        load: () => Effect.die("not needed"),
        loadServiceType: () => Effect.succeed(serviceType),
        loadServiceFeature: () => Effect.die("not used"),
        loadAppFeature: () => Effect.die("not used"),
      };
      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "slow-sync-app",
              runtime: 4,
              services: {
                [ServiceName.make("web")]: { type: "accelerated-appmount" },
                [ServiceName.make("api")]: { type: "accelerated-appmount" },
              },
            },
            slowBindMountCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive.pipe(Layer.provide(Layer.succeed(PluginRegistry, registry))))),
      );

      expect(fileSyncEngineIdReads).toBe(2);
      expect(appPlan.fileSync).toHaveLength(2);
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

  test("wraps service type validation failures as LandofileValidationError", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("worker")]: { type: "compose" },
        },
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (failure instanceof LandofileValidationError) {
        expect(failure._tag).toBe("LandofileValidationError");
        expect(failure.issues).toEqual(["services.worker"]);
        expect(failure.message).toContain('requires either "image:" or "composeBuild:"');
      }
    });
  });

  test("fails before apply when build artifacts require an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(
        {
          name: "myapp",
          runtime: 4,
          services: {
            [ServiceName.make("worker")]: {
              type: "compose",
              composeBuild: { context: "." },
            },
          },
        },
        {
          ...providerLandoCapabilities,
          artifactBuild: false,
        },
      );

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure._tag).toBe("CapabilityError");
        expect(failure.service).toBe("worker");
        expect(failure.feature).toBe("artifact build");
        expect(failure.capability).toBe("artifactBuild");
        expect(failure.remediation).toContain("pre-built image reference");
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

      const storeNames = appPlan.stores.map((s) => s.name);
      expect(storeNames).toContain("composeapp-worker-cache");
      expect(storeNames).toContain("composeapp-worker-state");
      expect(appPlan.stores.every((s) => s.scope === "service")).toBe(true);
    });
  });

  test("fails before apply when service storage requires an unsupported provider capability", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(
        {
          name: "myapp",
          runtime: 4,
          services: {
            [ServiceName.make("db")]: {
              image: "postgres:16",
              environment: { POSTGRES_PASSWORD: "lando" },
            },
          },
        },
        { ...providerLandoCapabilities, persistentStorage: false },
      );

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
        expect(failure.message).toContain("worker");
        expect(failure.message.toLowerCase()).toContain("global");
        expect(failure.remediation.toLowerCase()).toContain("global");
      }
    });
  });

  test("default excludes (node_modules, vendor, .git, tmp) are always merged into appMount.excludes", async () => {
    await withTempCwd(async () => {
      const appPlan = await planWithCustomRegistry({
        name: "defapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: { type: "appmount-only" },
        },
      });
      const web = appPlan.services[ServiceName.make("web")];
      expect(web?.appMount?.excludes).toEqual(FILE_SYNC_DEFAULT_EXCLUDES);
    });
  });

  test("user-authored excludes extend defaults rather than replace them", async () => {
    await withTempCwd(async () => {
      const appPlan = await planWithCustomRegistry({
        name: "extapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            type: "appmount-only",
            appMount: { target: "/app", excludes: ["dist"] },
          },
        },
      });
      const web = appPlan.services[ServiceName.make("web")];
      expect(web?.appMount?.excludes).toEqual([...FILE_SYNC_DEFAULT_EXCLUDES, "dist"]);
    });
  });

  test("service-type framework presets are preserved when user provides additional excludes", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        {
          name: "pyapp",
          runtime: 4,
          services: {
            [ServiceName.make("web")]: {
              image: "python:3.12",
              appMount: { target: "/app", excludes: ["dist"] },
            },
          },
        },
        providerLandoCapabilities,
      );
      const web = appPlan.services[ServiceName.make("web")];
      expect(web?.appMount?.excludes).toEqual(
        expect.arrayContaining([...FILE_SYNC_DEFAULT_EXCLUDES, "__pycache__", "dist"]),
      );
      expect(web?.appMount?.excludes).toContain("__pycache__");
    });
  });

  test("FileSyncPlan session.excludes inherits defaults on slow providers", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        { name: "myapp", runtime: 4, services: { [ServiceName.make("web")]: { image: "node:lts" } } },
        slowBindMountCapabilities,
      );
      const webEntry = appPlan.fileSync.find((e) => String(e.session.service) === "web");
      expect(webEntry).toBeDefined();
      expect(webEntry?.session.excludes).toEqual(
        expect.arrayContaining(["node_modules", "vendor", ".git", "tmp"]),
      );
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
      expect(storeNames).toEqual([
        "shadowapp-web-app-git-12945185",
        "shadowapp-web-app-node-modules-ad806e3f",
        "shadowapp-web-app-tmp-43bdc5ce",
        "shadowapp-web-app-vendor-64784057",
      ]);
      expect(appPlan.stores.every((s) => s.scope === "service")).toBe(true);

      const web = appPlan.services[ServiceName.make("web")];
      const shadowTargets = web?.storage.map((entry) => entry.target).sort() ?? [];
      expect(shadowTargets).toEqual([
        PortablePath.make("/app/.git"),
        PortablePath.make("/app/node_modules"),
        PortablePath.make("/app/tmp"),
        PortablePath.make("/app/vendor"),
      ]);
      expect(web?.appMount?.excludes).toEqual(["node_modules", "vendor", ".git", "tmp"]);
    });
  });

  test("shadow store names for /app/node_modules and /app/node-modules are distinct (no collision)", async () => {
    await withTempCwd(async () => {
      const makeApp = (exclude: string) =>
        planWithCustomRegistry({
          name: "shadowapp",
          runtime: 4,
          services: {
            [ServiceName.make("web")]: {
              type: "appmount-only",
              appMount: { target: "/app", excludes: [exclude] },
            },
          },
        });

      const planUnderscored = await makeApp("node_modules");
      const planHyphenated = await makeApp("node-modules");

      const namesUnderscored = planUnderscored.stores.map((s) => s.name);
      const namesHyphenated = planHyphenated.stores.map((s) => s.name);
      expect(namesUnderscored).toContain("shadowapp-web-app-node-modules-ad806e3f");
      expect(namesHyphenated).toContain("shadowapp-web-app-node-modules-6a42fc95");
      expect(namesUnderscored).not.toContain("shadowapp-web-app-node-modules-6a42fc95");
    });
  });

  test("image: postgres and postgres:16 classify as the postgres service type", async () => {
    await withTempCwd(async () => {
      const bareApp = await plan({
        name: "myapp",
        runtime: 4,
        services: { [ServiceName.make("db")]: { image: "postgres" } },
      });
      expect(bareApp.services[ServiceName.make("db")]?.type).toBe("postgres");

      const taggedApp = await plan({
        name: "myapp",
        runtime: 4,
        services: { [ServiceName.make("db")]: { image: "postgres:16" } },
      });
      expect(taggedApp.services[ServiceName.make("db")]?.type).toBe("postgres");
    });
  });

  test("image: postgrest:latest and postgresml:latest do NOT classify as postgres", async () => {
    await withTempCwd(async () => {
      for (const image of ["postgrest:latest", "postgresml:latest"]) {
        const exit = await planExit({
          name: "myapp",
          runtime: 4,
          services: { [ServiceName.make("db")]: { image } },
        });

        const failure = expectSomeFailure(exit);
        expect(failure).toBeInstanceOf(LandofileValidationError);
        if (failure instanceof LandofileValidationError) {
          expect(failure.message).toContain("db");
          expect(failure.message).not.toContain("type postgres");
        }
      }
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
