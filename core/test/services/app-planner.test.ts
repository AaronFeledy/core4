import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import {
  CapabilityError,
  LandofileValidationError,
  NotImplementedError,
  PluginLoadError,
  PublicationUnsupportedError,
} from "@lando/core/errors";
import {
  AbsolutePath,
  AppPlan,
  LandofileShape,
  LogSource,
  PluginManifest,
  PluginName,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/core/schema";
import { AppPlanner, ConfigService, LandofileService, PluginRegistry } from "@lando/core/services";
import type { AppFeatureDefinition, ServiceFeatureDefinition, ServiceType } from "@lando/core/services";
import type { GlobalConfig } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { makeLegacyServiceTypeFake } from "../_support/legacy-service-type.ts";

import { APP_PLAN_CACHE_HEADER_BYTES, writeCachedAppPlan } from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";
import { CacheServiceLive } from "@lando/engine/cache/service";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { LANDO_BASE_DEFAULT_FEATURE_IDS } from "@lando/engine/services/base/lando";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { LandofileServiceLive } from "@lando/engine/services/landofile-live";
import { AppPlannerLive, FILE_SYNC_DEFAULT_EXCLUDES } from "@lando/engine/services/planner";

const providerLandoCapabilities: ProviderCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
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
  composeServiceFields: { supported: ["labels"] },
  providerExtensions: ["compose", "labels", "registryCredentials"],
};

const composePreservedPathCapabilities: ProviderCapabilities = {
  ...providerLandoCapabilities,
  composePreservedPaths: {
    supported: ["depends_on.*.restart", "healthcheck.start_interval"],
  },
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
      ports: [{ target: 3000, published: 3000, protocol: "tcp" }],
      environment: { NODE_ENV: "development" },
      dependsOn: [{ service: "db" }],
    },
    [ServiceName.make("db")]: {
      image: "postgres:16",
      ports: [{ target: 5432, published: 5432, protocol: "tcp" }],
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
  const config: GlobalConfig = { defaultProviderId, telemetry: { enabled: false } };
  const load = Effect.succeed(config);
  return Layer.succeed(ConfigService, {
    load,
    get: <K extends keyof GlobalConfig>(key: K) =>
      Effect.map(load, (loadedConfig): GlobalConfig[K] => loadedConfig[key]),
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
      endpoints: [
        {
          _tag: "internal",
          protocol: "unix",
          socketPath: PortablePath.make("/var/run/socket-only.sock"),
          name,
        },
      ],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    }),
});

const publishedEndpointServiceType = makeLegacyServiceTypeFake({
  id: "published-endpoint",
  toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) =>
    Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "published-endpoint",
      provider,
      primary,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [{ _tag: "published", protocol: "http", port: 8080, name, publication: {} }],
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
    if (id === publishedEndpointServiceType.id) return Effect.succeed(publishedEndpointServiceType);
    return Effect.fail(
      new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
    );
  },
  loadServiceFeature: (id: string) => {
    const feature = [
      appMountOnlyServiceType.testFeature,
      socketOnlyServiceType.testFeature,
      publishedEndpointServiceType.testFeature,
    ].find((candidate) => candidate.id === id);
    return feature === undefined
      ? Effect.fail(
          new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
        )
      : Effect.succeed(feature);
  },
  loadAppFeature: (id: string) =>
    Effect.fail(new PluginLoadError({ message: `App feature ${id} is not registered.`, pluginName: id })),
};

const followLogSourceServiceType = (required: boolean): ServiceType => ({
  id: required ? "required-follow-log-source" : "optional-follow-log-source",
  name: required ? "required-follow-log-source" : "optional-follow-log-source",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: input.service,
      features: [],
      logSources: [
        Schema.decodeUnknownSync(LogSource)({
          id: "worker-file",
          path: "/var/log/worker.log",
          stream: "stdout",
          strategy: "follow",
          required,
        }),
      ],
    }),
});

const registryWithServiceType = (serviceType: ServiceType) => ({
  ...customPluginRegistry,
  list: Effect.succeed([
    Schema.decodeUnknownSync(PluginManifest)({
      name: PluginName.make("@example/log-source-type"),
      version: "1.0.0",
      api: 4 as const,
      contributes: { serviceTypes: [serviceType.id] },
    }),
  ]),
  loadServiceType: (id: string) =>
    id === serviceType.id ? Effect.succeed(serviceType) : customPluginRegistry.loadServiceType(id),
});

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
  return Option.getOrThrow(failure);
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

  test("carries bundled service-type log sources onto the service plan", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "logs-app",
          runtime: 4,
          services: { web: { type: "apache" } },
        }),
      );

      const web = appPlan.services[ServiceName.make("web")];
      expect(web?.logSources?.map((source) => String(source.id))).toEqual(["access", "error"]);
      expect(web?.logSources?.map((source) => source.strategy)).toEqual(["redirect", "redirect"]);
    });
  });

  test("lets user logs override service-type log source ids", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "logs-app",
          runtime: 4,
          services: {
            web: {
              type: "apache",
              logs: [
                {
                  id: "error",
                  label: "custom app error log",
                  path: "/app/var/log/error.log",
                  stream: "stderr",
                },
              ],
            },
          },
        }),
      );

      const web = appPlan.services[ServiceName.make("web")];
      const errorSource = web?.logSources?.find((source) => String(source.id) === "error");
      expect(errorSource?.label).toBe("custom app error log");
      expect(String(errorSource?.path)).toBe("/app/var/log/error.log");
      expect(errorSource?.strategy).toBe("follow");
      expect(web?.logSources?.map((source) => String(source.id))).toEqual(["access", "error"]);
    });
  });

  test("emits redirect log build steps for bundled redirect sources (stdout + stderr)", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "logs-app",
          runtime: 4,
          services: { web: { type: "apache" } },
        }),
      );

      const web = appPlan.services[ServiceName.make("web")];
      const buildSteps = (
        web?.extensions["@lando/core/service-features"] as
          | {
              readonly buildSteps?: ReadonlyArray<{
                readonly id: string;
                readonly phase: string;
                readonly command: unknown;
              }>;
            }
          | undefined
      )?.buildSteps;
      expect(buildSteps?.map(({ id }) => id)).toEqual([
        "lando.boot:scaffold",
        "lando-log-redirect-mkdir:access",
        "lando-log-redirect:access",
        "lando-log-redirect-mkdir:error",
        "lando-log-redirect:error",
      ]);
      expect(buildSteps?.slice(1)).toEqual([
        {
          id: "lando-log-redirect-mkdir:access",
          phase: "build",
          command: ["mkdir", "-p", "/usr/local/apache2/logs"],
        },
        {
          id: "lando-log-redirect:access",
          phase: "build",
          command: ["ln", "-sf", "/dev/stdout", "/usr/local/apache2/logs/access_log"],
        },
        {
          id: "lando-log-redirect-mkdir:error",
          phase: "build",
          command: ["mkdir", "-p", "/usr/local/apache2/logs"],
        },
        {
          id: "lando-log-redirect:error",
          phase: "build",
          command: ["ln", "-sf", "/dev/stderr", "/usr/local/apache2/logs/error_log"],
        },
      ]);
    });
  });

  test("emits parent creation before each PHP-FPM redirect link", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "php-logs-app",
          runtime: 4,
          services: { appserver: { type: "php:8.2" } },
        }),
      );

      const appserver = appPlan.services[ServiceName.make("appserver")];
      const buildSteps = (
        appserver?.extensions["@lando/core/service-features"] as
          | { readonly buildSteps?: ReadonlyArray<unknown> }
          | undefined
      )?.buildSteps;
      // PHP prerequisite steps may precede the redirects; the invariant is that
      // redirects are finalization steps with each mkdir immediately before its link.
      expect(buildSteps?.slice(-4)).toEqual([
        {
          id: "lando-log-redirect-mkdir:access",
          phase: "build",
          command: ["mkdir", "-p", "/var/log/php-fpm"],
        },
        {
          id: "lando-log-redirect:access",
          phase: "build",
          command: ["ln", "-sf", "/dev/stdout", "/var/log/php-fpm/access.log"],
        },
        {
          id: "lando-log-redirect-mkdir:error",
          phase: "build",
          command: ["mkdir", "-p", "/var/log/php-fpm"],
        },
        {
          id: "lando-log-redirect:error",
          phase: "build",
          command: ["ln", "-sf", "/dev/stderr", "/var/log/php-fpm/error.log"],
        },
      ]);
    });
  });

  test("a Compose build normalizes into ServicePlan.artifact for a non compose service type", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "compose-build",
        runtime: 4,
        services: {
          worker: {
            type: "socket-only",
            build: {
              context: "./docker",
              dockerfile: "Containerfile",
              args: { NODE_ENV: "production" },
              target: "runtime",
            },
          },
        },
      });

      // When
      const appPlan = await planWithCustomRegistry(landofile);

      // Then
      expect(appPlan.services[ServiceName.make("worker")]?.artifact).toEqual({
        kind: "build",
        context: AbsolutePath.make(join(appRoot, "docker")),
        spec: PortablePath.make("Containerfile"),
        args: { NODE_ENV: "production" },
        target: "runtime",
      });
    });
  });

  test("a Compose build with dockerfile_inline carries specInline into the artifact", async () => {
    await withTempCwd(async () => {
      // Given
      const specInline = "FROM scratch\nLABEL purpose=test\n";
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "inline-compose-build",
        runtime: 4,
        services: {
          worker: { type: "socket-only", build: { context: ".", dockerfile_inline: specInline } },
        },
      });

      // When
      const appPlan = await planWithCustomRegistry(landofile);

      // Then
      const artifact = appPlan.services[ServiceName.make("worker")]?.artifact;
      expect(artifact?.kind).toBe("build");
      if (artifact?.kind === "build") expect(artifact.specInline).toBe(specInline);
    });
  });

  test("build.artifact scripts become build phase steps", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "artifact-build-scripts",
        runtime: 4,
        services: { worker: { type: "socket-only", build: { artifact: "install-dependencies" } } },
      });

      // When
      const appPlan = await planWithCustomRegistry(landofile);

      // Then
      expect(
        appPlan.services[ServiceName.make("worker")]?.extensions["@lando/core/service-features"],
      ).toMatchObject({
        buildSteps: [
          {
            id: "authored-artifact:1",
            phase: "build",
            command: ["sh", "-lc", "install-dependencies"],
          },
        ],
      });
    });
  });

  test("build.app scripts still become app phase steps", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "app-build",
        runtime: 4,
        services: {
          web: { type: "node:lts", build: { app: ["npm ci", "npm run build"] } },
        },
      });

      // When
      const appPlan = await plan(landofile);

      // Then
      const web = appPlan.services[ServiceName.make("web")];
      const extension = web?.extensions["@lando/core/service-features"];
      expect(extension).toMatchObject({
        buildSteps: [
          { id: "lando.boot:scaffold", phase: "build" },
          { id: "authored-app:1", phase: "app", command: { command: ["sh", "-lc", "npm ci"] } },
          { id: "authored-app:2", phase: "app", command: { command: ["sh", "-lc", "npm run build"] } },
        ],
      });
    });
  });

  test("artifact steps precede app steps when both are present", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "ordered-build-scripts",
        runtime: 4,
        services: {
          worker: {
            type: "socket-only",
            build: { artifact: ["artifact-one", "artifact-two"], app: "app-one" },
          },
        },
      });

      // When
      const appPlan = await planWithCustomRegistry(landofile);

      // Then
      const extension =
        appPlan.services[ServiceName.make("worker")]?.extensions["@lando/core/service-features"];
      const buildSteps =
        typeof extension === "object" &&
        extension !== null &&
        "buildSteps" in extension &&
        Array.isArray(extension.buildSteps)
          ? extension.buildSteps
          : [];
      const authoredSteps = buildSteps.filter(
        (step) =>
          typeof step === "object" &&
          step !== null &&
          "id" in step &&
          typeof step.id === "string" &&
          step.id.startsWith("authored-"),
      );
      expect(authoredSteps).toEqual([
        {
          id: "authored-artifact:1",
          phase: "build",
          command: ["sh", "-lc", "artifact-one"],
        },
        {
          id: "authored-artifact:2",
          phase: "build",
          command: ["sh", "-lc", "artifact-two"],
        },
        { id: "authored-app:1", phase: "app", command: { command: ["sh", "-lc", "app-one"] } },
      ]);
    });
  });

  test("an authored Compose build overrides a plugin-set artifact", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "plugin-artifact",
        runtime: 4,
        services: { worker: { type: "appmount-only", build: "." } },
      });

      // When
      const appPlan = await planWithCustomRegistry(landofile);

      // Then
      expect(appPlan.services[ServiceName.make("worker")]?.artifact).toEqual({
        kind: "build",
        context: AbsolutePath.make(appRoot),
      });
    });
  });

  test("a typed service Compose build requires provider artifactBuild capability", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "typed-compose-build",
        runtime: 4,
        services: { worker: { type: "appmount-only", build: "." } },
      });

      // When
      const exit = await planExitWithCustomRegistry(landofile, {
        ...providerLandoCapabilities,
        artifactBuild: false,
      });

      // Then
      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure.capability).toBe("artifactBuild");
        expect(failure.service).toBe("worker");
      }
    });
  });

  test("image plus a Compose build fails for a non-compose service type", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "conflicting-artifact-sources",
        runtime: 4,
        services: {
          worker: { type: "appmount-only", image: "alpine:3", build: { context: "." } },
        },
      });

      // When
      const exit = await planExitWithCustomRegistry(landofile);

      // Then
      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (failure instanceof LandofileValidationError) {
        expect(failure._tag).toBe("LandofileValidationError");
        expect(failure.issues).toEqual(["services.worker.build"]);
      }
    });
  });

  test("raw lando accepts a Compose build without an image", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "raw-lando-compose-build",
        runtime: 4,
        services: { worker: { type: "lando", build: { context: "." } } },
      });

      // When
      const appPlan = await plan(landofile);

      // Then
      expect(appPlan.services[ServiceName.make("worker")]?.artifact).toEqual({
        kind: "build",
        context: AbsolutePath.make(appRoot),
      });
    });
  });

  test("image plus Lando-family build scripts remains valid", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "lando-build-scripts",
        runtime: 4,
        services: {
          worker: { type: "lando", image: "alpine:3", build: { app: "echo ready" } },
        },
      });

      // When
      const appPlan = await plan(landofile);

      // Then
      expect(appPlan.services[ServiceName.make("worker")]?.artifact).toEqual({
        kind: "ref",
        ref: "alpine:3",
      });
      expect(
        appPlan.services[ServiceName.make("worker")]?.extensions["@lando/core/service-features"],
      ).toMatchObject({
        buildSteps: [
          { id: "lando.boot:scaffold", phase: "build" },
          { id: "authored-app:1", phase: "app", command: { command: ["sh", "-lc", "echo ready"] } },
        ],
      });
    });
  });

  test("emits redirect build steps for nginx bundled log sources", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "logs-app",
          runtime: 4,
          services: { web: { type: "nginx" } },
        }),
      );
      const web = appPlan.services[ServiceName.make("web")];
      const buildSteps = (
        web?.extensions["@lando/core/service-features"] as
          | { readonly buildSteps?: ReadonlyArray<{ readonly id: string }> }
          | undefined
      )?.buildSteps;
      expect(buildSteps?.[0]?.id).toBe("lando.boot:scaffold");
      expect(buildSteps?.slice(1).every((step) => step.id.startsWith("lando-log-redirect"))).toBe(true);
      expect((buildSteps?.length ?? 0) > 1).toBe(true);
    });
  });

  test("emits no redirect build steps for a service without redirect sources", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "logs-app",
          runtime: 4,
          services: {
            web: {
              type: "compose",
              image: "docker.io/library/nginx:1.27",
              appMount: false,
            },
          },
        }),
      );
      const web = appPlan.services[ServiceName.make("web")];
      expect(web?.extensions["@lando/core/service-features"]).toEqual({
        featureIds: ["service-lando.compose"],
        buildSteps: [],
      });
    });
  });

  test("fails planning when a required follow log source needs unsupported serviceLogSources", async () => {
    await withTempCwd(async () => {
      const serviceType = followLogSourceServiceType(true);
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            Schema.decodeUnknownSync(LandofileShape)({
              name: "logs-app",
              runtime: 4,
              services: { worker: { type: serviceType.id } },
            }),
            { ...providerLandoCapabilities, serviceLogSources: false },
          ),
        ).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(Layer.succeed(PluginRegistry, registryWithServiceType(serviceType))),
        ),
      );

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure._tag).toBe("CapabilityError");
        expect(failure.service).toBe("worker");
        expect(failure.feature).toBe("required follow log source worker-file");
        expect(failure.capability).toBe("serviceLogSources");
        expect(failure.providerId).toBe("lando");
        expect(failure.remediation).toContain("strategy: redirect");
        expect(failure.remediation).toContain("serviceLogSources");
      }
    });
  });

  test("records unavailable non-required follow log sources without mutating resolved sources", async () => {
    await withTempCwd(async () => {
      const serviceType = followLogSourceServiceType(false);
      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            Schema.decodeUnknownSync(LandofileShape)({
              name: "logs-app",
              runtime: 4,
              services: { worker: { type: serviceType.id } },
            }),
            { ...providerLandoCapabilities, serviceLogSources: false },
          ),
        ).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(Layer.succeed(PluginRegistry, registryWithServiceType(serviceType))),
        ),
      );

      const worker = appPlan.services[ServiceName.make("worker")];
      expect(
        worker?.logSources?.map((source) => ({ id: String(source.id), strategy: source.strategy })),
      ).toEqual([{ id: "worker-file", strategy: "follow" }]);
      expect(worker?.extensions["@lando/core/log-sources"]).toEqual({
        unavailableFollow: [
          {
            id: "worker-file",
            path: "/var/log/worker.log",
            reason:
              "Provider does not advertise serviceLogSources; use strategy: redirect or choose a provider with serviceLogSources.",
          },
        ],
      });
    });
  });

  test("records host-proxy runLando unavailable when hostReachability is none without mutating service transport", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "host-proxy-none",
          runtime: 4,
          services: { web: { type: "node:lts" } },
        }),
        { ...providerLandoCapabilities, hostReachability: "none" },
      );

      const web = appPlan.services[ServiceName.make("web")];
      expect(appPlan.extensions["@lando/core/host-proxy"]).toEqual({
        runLando: {
          availability: "unavailable",
          reason: "Provider hostReachability is none; host-proxy runLando is disabled.",
        },
      });
      expect(web?.environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
      expect(web?.environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
      expect(web?.mounts).not.toContainEqual(
        expect.objectContaining({ target: "/run/lando/host-proxy.sock" }),
      );
    });
  });

  test("records host-proxy runLando unavailable when the provider declares no container target", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "host-proxy-no-target",
          runtime: 4,
          services: { web: { type: "node:lts" } },
        }),
        { ...providerLandoCapabilities, hostProxy: { containerTargets: [] } },
      );

      expect(appPlan.extensions["@lando/core/host-proxy"]).toEqual({
        runLando: {
          availability: "unavailable",
          reason: "Provider declares no host-proxy Linux container target; host-proxy runLando is disabled.",
        },
      });
    });
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

  test("compose-based global service injects no LANDO_* env layer", async () => {
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
    const landoKeys = Object.keys(mailpit?.environment ?? {}).filter(
      (key) => key === "LANDO" || key.startsWith("LANDO_"),
    );
    expect(landoKeys).toEqual([]);
    expect(mailpit?.environment.LANDO_APP_KIND).toBeUndefined();
    expect(mailpit?.environment.LANDO_MAIL_HOST).toBeUndefined();
    expect(mailpit?.environment.LANDO_MAIL_PORT).toBeUndefined();
  });

  test("loads scalar and list env_file inputs with explicit environment taking precedence", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      await writeFile(join(appRoot, "base.env"), "SHARED=base\nBASE_ONLY=yes\n");
      await writeFile(join(appRoot, "override.env"), "SHARED=override\nLIST_ONLY=yes\n");
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "env-files",
        runtime: 4,
        services: {
          scalar: { image: "node:lts", env_file: "base.env" },
          list: {
            image: "node:lts",
            env_file: ["base.env", "override.env"],
            environment: { SHARED: "explicit" },
          },
        },
      });

      // When
      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(PluginRegistryLive),
          Effect.provide(FileSystemLive),
        ),
      );

      // Then
      expect(appPlan.services[ServiceName.make("scalar")]?.environment).toMatchObject({
        SHARED: "base",
        BASE_ONLY: "yes",
      });
      expect(appPlan.services[ServiceName.make("list")]?.environment).toMatchObject({
        SHARED: "explicit",
        BASE_ONLY: "yes",
        LIST_ONLY: "yes",
      });
    });
  });

  test("resolves env_file relative to the discovered app root from a nested directory", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const nested = join(appRoot, "nested");
      await mkdir(nested);
      await writeFile(
        join(appRoot, ".lando.yml"),
        [
          "name: nested-env-file",
          "services:",
          "  web:",
          "    image: node:lts",
          "    env_file: values.env",
          "",
        ].join("\n"),
      );
      await writeFile(join(appRoot, "values.env"), "FROM_APP_ROOT=yes\n");
      await writeFile(join(nested, "values.env"), "FROM_NESTED=yes\n");
      process.chdir(nested);
      const landofile = await Effect.runPromise(
        Effect.flatMap(LandofileService, (service) => service.discover).pipe(
          Effect.provide(LandofileServiceLive),
        ),
      );

      // When
      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(PluginRegistryLive),
          Effect.provide(FileSystemLive),
        ),
      );

      // Then
      expect(appPlan.root).toBe(AbsolutePath.make(appRoot));
      expect(appPlan.services[ServiceName.make("web")]?.environment.FROM_APP_ROOT).toBe("yes");
      expect(appPlan.services[ServiceName.make("web")]?.environment.FROM_NESTED).toBeUndefined();
    });
  });

  test("fails with remediation when an env file is missing", async () => {
    await withTempCwd(async () => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "missing-env-file",
        runtime: 4,
        services: { web: { image: "node:lts", env_file: "missing.env" } },
      });

      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(PluginRegistryLive),
          Effect.provide(FileSystemLive),
        ),
      );

      // Then
      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(String(failure)).toContain("missing.env");
      expect(String(failure)).toContain("Create a readable env file");
    });
  });

  test("fails rather than skipping env files when FileSystem is unavailable", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "env-file-without-filesystem",
      runtime: 4,
      services: { web: { image: "node:lts", env_file: "declared.env" } },
    });

    // When
    const exit = await planExit(landofile);

    // Then
    const failure = expectSomeFailure(exit);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(String(failure)).toContain("FileSystem service is unavailable");
  });

  test("fails with source, line, and remediation when an env file is malformed", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      await writeFile(join(appRoot, "broken.env"), "VALID=yes\nBROKEN\n");
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "malformed-env-file",
        runtime: 4,
        services: { web: { image: "node:lts", env_file: "broken.env" } },
      });

      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(PluginRegistryLive),
          Effect.provide(FileSystemLive),
        ),
      );

      // Then
      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(String(failure)).toContain(`${join(appRoot, "broken.env")}:2`);
      expect(String(failure)).toContain("Use KEY=VALUE entries");
    });
  });

  test("applies top-level env_file to every service below service files and explicit environment", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      await writeFile(join(appRoot, "shared.env"), "SHARED=top-first\nTOP_ONLY=yes\n");
      await writeFile(join(appRoot, "shared.local.env"), "SHARED=top-last\nTOP_LAST_ONLY=yes\n");
      await writeFile(join(appRoot, "service.env"), "SHARED=service\nSERVICE_ONLY=yes\n");
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "top-level-env-file",
        runtime: 4,
        env_file: ["shared.env", "shared.local.env"],
        services: {
          inherited: { image: "node:lts" },
          serviceFile: { image: "node:lts", env_file: "service.env" },
          explicit: {
            image: "node:lts",
            env_file: "service.env",
            environment: { SHARED: "explicit" },
          },
        },
      });

      // When
      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(PluginRegistryLive),
          Effect.provide(FileSystemLive),
        ),
      );

      // Then
      expect(appPlan.services[ServiceName.make("inherited")]?.environment).toMatchObject({
        SHARED: "top-last",
        TOP_ONLY: "yes",
        TOP_LAST_ONLY: "yes",
      });
      expect(appPlan.services[ServiceName.make("serviceFile")]?.environment).toMatchObject({
        SHARED: "service",
        TOP_ONLY: "yes",
        SERVICE_ONLY: "yes",
      });
      expect(appPlan.services[ServiceName.make("explicit")]?.environment).toMatchObject({
        SHARED: "explicit",
        TOP_ONLY: "yes",
        SERVICE_ONLY: "yes",
      });
    });
  });

  test("fails with remediation for a missing top-level env_file even when the app has no services", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "missing-top-level-env-file",
        runtime: 4,
        env_file: "missing.env",
      });

      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
          Effect.provide(AppPlannerLive),
          Effect.provide(PluginRegistryLive),
          Effect.provide(FileSystemLive),
        ),
      );

      // Then
      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      expect(String(failure)).toContain(join(appRoot, "missing.env"));
      expect(String(failure)).toContain("Create a readable env file");
    });
  });

  test("preserves canonical map and list labels without emitting empty compose extensions", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "service-labels",
      runtime: 4,
      services: {
        mapped: { image: "node:lts", labels: { "io.lando.map": "mapped" } },
        listed: { image: "node:lts", labels: ["io.lando.list=listed", "io.lando.bare"] },
        empty: { image: "node:lts" },
      },
    });

    // When
    const appPlan = await plan(landofile);

    // Then
    expect(appPlan.services[ServiceName.make("mapped")]?.extensions).toMatchObject({
      compose: { labels: { "io.lando.map": "mapped" } },
    });
    expect(appPlan.services[ServiceName.make("listed")]?.extensions).toMatchObject({
      compose: { labels: { "io.lando.list": "listed", "io.lando.bare": "" } },
    });
    expect(
      appPlan.services[ServiceName.make("listed")]?.extensions["@lando/core/service-features"],
    ).toBeDefined();
    expect(appPlan.services[ServiceName.make("empty")]?.extensions.compose).toBeUndefined();
  });

  test("reuses the persisted app plan cache until planning inputs change", async () => {
    await withTempCwd(async (appRoot) => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-plan-cache-root-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      await writeFile(join(appRoot, "cache.env"), "ENV_FILE_VALUE=one\n");
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
            FileSystemLive,
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
              loadServiceFeature: (id: string) =>
                id === cachedType.testFeature.id
                  ? Effect.succeed(cachedType.testFeature)
                  : Effect.fail(
                      new PluginLoadError({
                        message: `Service feature ${id} is not registered.`,
                        pluginName: id,
                      }),
                    ),
              loadAppFeature: () => Effect.die("not used"),
            }),
          ),
        ),
      );
      const cachedLandofile: LandofileShape = {
        name: "cached-app",
        env_file: ["cache.env"],
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
        const cachedBytes = await readFile(appPlanCachePath(cacheRoot, "cached-app", process.cwd()));
        const second = await runPlan(cachedLandofile);
        await writeFile(join(appRoot, "cache.env"), "ENV_FILE_VALUE=two\n");
        const changedFromFile = await runPlan(cachedLandofile);
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
        expect(JSON.stringify(first)).not.toContain("LANDO_HOST_PROXY_TOKEN");
        expect(cachedBytes.toString("utf8")).not.toContain("LANDO_HOST_PROXY_TOKEN");
        expect(second.metadata.resolvedAt).toEqual(first.metadata.resolvedAt);
        expect(changedFromFile.services[ServiceName.make("web")]?.environment.ENV_FILE_VALUE).toBe("two");
        expect(changed.name).toBe("cached-app");
        expect(servicePlanCalls).toBe(3);
      } finally {
        if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  test("invalidates the persisted app plan cache when top-level env_file content changes", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-plan-env-file-cache-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      await writeFile(join(appRoot, "cache.env"), "ENV_FILE_VALUE=one\n");
      let servicePlanCalls = 0;
      const cachedType = makeLegacyServiceTypeFake({
        id: "env-file-cache-type",
        normalizeConfig: ({ environment: _environment, ...normalizedConfig }) => normalizedConfig,
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
            type: "env-file-cache-type",
            provider,
            primary,
            artifact: { kind: "ref", ref: "env-file-cache-type:latest" },
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
            FileSystemLive,
            Layer.succeed(PluginRegistry, {
              list: Effect.succeed([
                Schema.decodeUnknownSync(PluginManifest)({
                  name: PluginName.make("@lando/env-file-cache"),
                  version: "1.0.0",
                  api: 4 as const,
                  contributes: { serviceTypes: ["env-file-cache-type"] },
                }),
              ]),
              load: () => Effect.die("not needed"),
              loadServiceType: () => Effect.succeed(cachedType),
              loadServiceFeature: (id: string) =>
                id === cachedType.testFeature.id
                  ? Effect.succeed(cachedType.testFeature)
                  : Effect.fail(
                      new PluginLoadError({
                        message: `Service feature ${id} is not registered.`,
                        pluginName: id,
                      }),
                    ),
              loadAppFeature: () => Effect.die("not used"),
            }),
          ),
        ),
      );
      const landofile: LandofileShape = {
        name: "env-file-cache-app",
        env_file: ["cache.env"],
        services: { [ServiceName.make("web")]: { type: "env-file-cache-type" } },
      };

      try {
        const runPlan = () =>
          Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
              Effect.provide(layer),
            ),
          );

        // When
        await runPlan();

        // Then
        expect(servicePlanCalls).toBe(1);

        // When
        await runPlan();

        // Then
        expect(servicePlanCalls).toBe(1);

        // When
        await writeFile(join(appRoot, "cache.env"), "ENV_FILE_VALUE=two\n");
        await runPlan();

        // Then
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
      expect(appPlan.routes[0]?.backend).toEqual({
        service: ServiceName.make("web"),
        protocol: "http",
        port: 3000,
      });
      expect(appPlan.requires?.globalServices).toEqual(["traefik"]);
    });
  });

  test("resolves an authored service route against its named endpoint", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "myapp",
          runtime: 4,
          services: {
            web: {
              type: "node:lts",
              routes: [
                { hostname: "custom.example.test", scheme: "both", endpoint: "web", pathPrefix: "/api" },
              ],
            },
          },
        }),
      );

      expect(appPlan.routes).toEqual([
        {
          hostname: "custom.example.test",
          scheme: "both",
          service: ServiceName.make("web"),
          endpoint: "web",
          pathPrefix: "/api",
          backend: { service: ServiceName.make("web"), protocol: "http", port: 3000 },
        },
      ]);
      expect(appPlan.services[ServiceName.make("web")]?.routes).toEqual([{ index: 0 }]);
    });
  });

  test("emits one canonical route when a service has multiple HTTP endpoints", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "myapp",
          runtime: 4,
          services: {
            web: {
              type: "compose",
              image: "nginx:1.27",
              appMount: false,
              endpoints: [
                { _tag: "internal", name: "primary", protocol: "http", port: 8080 },
                { _tag: "internal", name: "admin", protocol: "http", port: 8081 },
              ],
            },
          },
        }),
      );

      expect(appPlan.routes).toHaveLength(1);
      expect(appPlan.routes[0]).toMatchObject({
        hostname: "web.myapp.lndo.site",
        endpoint: "primary",
        backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
      });
    });
  });

  test("fails planning when a service declares duplicate endpoint names", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "myapp",
          runtime: 4,
          services: {
            web: {
              type: "compose",
              image: "nginx:1.27",
              appMount: false,
              endpoints: [
                { _tag: "internal", name: "web", protocol: "http", port: 8080 },
                { _tag: "internal", name: "web", protocol: "http", port: 8081 },
              ],
            },
          },
        }),
      );

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (failure instanceof LandofileValidationError) {
        expect(failure.issues).toEqual(["services.web.endpoints"]);
      }
    });
  });

  test("fails routed planning when shared cross-app networking is unavailable", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(landofileFixture, {
        ...providerLandoCapabilities,
        sharedCrossAppNetwork: false,
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      if (failure instanceof CapabilityError) {
        expect(failure.feature).toBe("routes");
        expect(failure.capability).toBe("sharedCrossAppNetwork");
      }
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
        base: "l337",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "l337" as const,
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
        loadServiceFeature: (id: string) =>
          id === buildStepServiceType.testFeature.id
            ? Effect.succeed(buildStepServiceType.testFeature)
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
              services: { [ServiceName.make("web")]: { type: buildStepServiceType.id } },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      expect(appPlan.services[ServiceName.make("web")]?.extensions["@lando/core/service-features"]).toEqual({
        source: "service-feature",
        featureIds: ["build-step-backed.test-plan"],
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

  test("applyAuthoredDependencies defaults condition to service_started and required to true", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "authored-dependencies",
      runtime: 4,
      services: {
        web: { type: "appmount-only", dependsOn: ["db"] },
        db: { type: "appmount-only" },
      },
    });

    // When
    const appPlan = await planWithCustomRegistry(landofile);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.dependsOn).toEqual([
      { service: ServiceName.make("db"), condition: "service_started", required: true },
    ]);
  });

  test("mergeComposeExtension preserves an explicit restart: false on the compose extension", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "authored-dependency-restart",
      runtime: 4,
      services: {
        web: { type: "appmount-only", dependsOn: [{ service: "db", restart: false }] },
        db: { type: "appmount-only" },
      },
    });

    // When
    const appPlan = await planWithCustomRegistry(landofile, composePreservedPathCapabilities);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.extensions.compose).toMatchObject({
      depends_on: { db: { restart: false } },
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
      expect(web?.endpoints).toEqual([
        { _tag: "published", port: 3000, protocol: "http", publication: { hostPort: 3000 } },
      ]);
      expect(web?.dependsOn).toEqual([
        { service: ServiceName.make("db"), condition: "service_started", required: true },
      ]);

      expect(db?.type).toBe("postgres");
      expect(db?.artifact).toEqual({ kind: "ref", ref: "postgres:16" });
      expect(db?.environment.POSTGRES_USER).toBe("lando");
      expect(db?.environment.POSTGRES_DB).toBe("myapp");
      expect(db?.environment.POSTGRES_PASSWORD).toBe("lando");
      expect(db?.endpoints).toEqual([
        { _tag: "published", port: 5432, protocol: "tcp", publication: { hostPort: 5432 } },
      ]);
      expect(db?.storage[0]?.target).toBe(PortablePath.make("/var/lib/postgresql/data"));
    });
  });

  test("plans a compose service publishing several ports without duplicate endpoint names", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("proxy")]: {
            type: "compose",
            image: "traefik:v3.3",
            ports: [
              { target: 80, protocol: "tcp" },
              { target: 443, protocol: "tcp" },
              { target: 8080, protocol: "tcp" },
            ],
          },
        },
      });

      const proxy = appPlan.services[ServiceName.make("proxy")];
      expect(proxy?.endpoints).toEqual([
        { _tag: "published", port: 80, protocol: "tcp", publication: {} },
        { _tag: "published", port: 443, protocol: "tcp", publication: {} },
        { _tag: "published", port: 8080, protocol: "tcp", publication: {} },
      ]);
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
        loadServiceFeature: (id: string) =>
          id === serviceType.testFeature.id
            ? Effect.succeed(serviceType.testFeature)
            : Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              ),
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
        expect(failure.message).toContain('requires either "image:" or "build:"');
      }
    });
  });

  test("a Compose build fails at planning when the provider lacks artifactBuild", async () => {
    await withTempCwd(async () => {
      const exit = await planExit(
        {
          name: "myapp",
          runtime: 4,
          services: {
            [ServiceName.make("worker")]: {
              type: "compose",
              build: { context: "." },
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
      const exit = await planExitWithCustomRegistry(
        {
          name: "published-app",
          runtime: 4,
          services: { [ServiceName.make("web")]: { type: "published-endpoint" } },
        },
        { ...providerLandoCapabilities, hostPortPublish: "none" },
      );

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(PublicationUnsupportedError);
      expect(failure).toMatchObject({
        _tag: "PublicationUnsupportedError",
        service: "web",
        capability: "hostPortPublish",
        providerId: "lando",
        remediation:
          "Choose a provider with host port publish support or make service web endpoints internal.",
      });
    });
  });

  test("requires the host-port capability for a long-form Compose published port", async () => {
    await withTempCwd(async () => {
      const landofile: LandofileShape = {
        name: "myapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            type: "compose",
            image: "nginx:alpine",
            ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "tcp" }],
          },
        },
      };

      const exit = await planExit(landofile, {
        ...providerLandoCapabilities,
        hostPortPublish: "none",
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(PublicationUnsupportedError);
      expect(failure).toMatchObject({
        _tag: "PublicationUnsupportedError",
        service: "web",
        capability: "hostPortPublish",
      });

      // Proves the failure above came from a genuinely published endpoint, not a vacuous pass.
      const appPlan = await plan(landofile, {
        ...providerLandoCapabilities,
        hostPortPublish: "native",
      });
      expect(appPlan.services[ServiceName.make("web")]?.endpoints).toEqual([
        {
          _tag: "published",
          port: 80,
          protocol: "tcp",
          publication: { bindAddress: "127.0.0.1", hostPort: 8080 },
        },
      ]);
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
          _tag: "internal",
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
            volumes: [
              { type: "volume", source: "worker-state", target: "/var/state", readOnly: false },
              { type: "volume", source: "worker-cache", target: "/var/cache", readOnly: false },
            ],
          },
        },
      });

      const storeNames = appPlan.stores.map((s) => s.name);
      expect(storeNames).toContain("composeapp-worker-cache");
      expect(storeNames).toContain("composeapp-worker-state");
      expect(appPlan.stores.every((s) => s.scope === "service")).toBe(true);
    });
  });

  test("plans cache storage as cross-app lando-cache volumes with destination-derived keys", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "cacheapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            type: "compose",
            image: "node:22",
            storage: [
              {
                store: "npm-cache",
                target: "/home/node/.npm",
                kind: "cache",
              },
              {
                store: "composer-cache",
                target: "/tmp/composer/cache",
                kind: "cache",
                key: "php-deps",
              },
            ],
          },
        },
      });

      expect(appPlan.services[ServiceName.make("web")]?.storage.map((mount) => mount.store)).toEqual(
        expect.arrayContaining(["lando-cache-home-node-npm", "lando-cache-php-deps"]),
      );
      expect(appPlan.stores.filter((store) => store.kind === "cache")).toEqual([
        { name: "lando-cache-home-node-npm", scope: "global", kind: "cache", key: "home-node-npm" },
        { name: "lando-cache-php-deps", scope: "global", kind: "cache", key: "php-deps" },
      ]);
    });
  });

  test("lets authored storage win over an overlapping compose volume at the same container path", async () => {
    await withTempCwd(async () => {
      const appPlan = await plan({
        name: "overlapapp",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            type: "compose",
            image: "node:22",
            volumes: [{ type: "volume", source: "worker-cache", target: "/var/cache", readOnly: false }],
            storage: [
              {
                store: "worker-cache",
                target: "/var/cache",
                kind: "cache",
              },
              {
                store: "extra-data",
                target: "/data/extra",
              },
            ],
          },
        },
      });

      const webStorage = appPlan.services[ServiceName.make("web")]?.storage ?? [];
      expect(webStorage.filter((mount) => String(mount.target) === "/var/cache")).toEqual([
        { store: "lando-cache-var-cache", target: PortablePath.make("/var/cache"), readOnly: false },
      ]);
      expect(webStorage.map((mount) => mount.store)).toEqual(
        expect.arrayContaining(["lando-cache-var-cache", "extra-data"]),
      );
      expect(appPlan.stores.map((store) => store.name)).toEqual(
        expect.arrayContaining(["lando-cache-var-cache", "extra-data"]),
      );
      expect(appPlan.stores.some((store) => store.name === "overlapapp-worker-cache")).toBe(false);
    });
  });

  test("rejects service-scoped cache storage because cache volumes are global by nature", async () => {
    await withTempCwd(async () => {
      const exit = await planExit({
        name: "badcache",
        runtime: 4,
        services: {
          [ServiceName.make("web")]: {
            type: "compose",
            image: "node:22",
            storage: [
              {
                store: "npm-cache",
                target: "/home/node/.npm",
                scope: "service",
                kind: "cache",
              },
            ],
          },
        },
      });

      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (failure instanceof LandofileValidationError) {
        expect(failure.message).toContain("kind: cache");
        expect(failure.message).toContain("scope: service");
        expect(failure.issues).toContain("services.web.storage[0].scope");
      }
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

  test("rejects storage scope: global with NotImplementedError until cross-app global storage is supported", async () => {
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

  for (const { label, name, slug } of [
    { label: "spaces", name: "My App", slug: "my-app" },
    { label: "commas", name: "c,o,m,m,a", slug: "c-o-m-m-a" },
    { label: "uppercase letters", name: "UPPER", slug: "upper" },
    { label: "punctuation", name: "bad name!", slug: "bad-name" },
    { label: "an over-length value", name: "a".repeat(100), slug: "a".repeat(57) },
    { label: "digits and hyphens", name: "lando-4-app", slug: "lando-4-app" },
    { label: "the DNS-safe boundary", name: "b".repeat(57), slug: "b".repeat(57) },
  ]) {
    test(`normalizes ${label} into DNS-safe runtime app identity`, async () => {
      // Given
      const landofile: LandofileShape = {
        name,
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: "node:22" } },
      };

      // When
      const appPlan = await withTempCwd(() => plan(landofile));

      // Then
      expect(appPlan.name).toBe(name);
      expect(appPlan.id).toBe(slug);
      expect(appPlan.slug).toBe(slug);
      expect(appPlan.networks).toEqual([{ name: `lando-${slug}`, shared: false, driver: "bridge" }]);
      expect(appPlan.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web")]).toContain(
        `web.${slug}.internal`,
      );
      expect(appPlan.routes[0]?.hostname).toBe(`web.${slug}.lndo.site`);
    });
  }

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

  test("plans a Compose CMD healthcheck with parsed durations", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-healthcheck",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          healthcheck: {
            test: ["CMD", "curl", "-f", "http://localhost"],
            interval: "30s",
            timeout: "1m30s",
            retries: 3,
            start_period: "1h2m3s",
          },
        },
      },
    });

    // When
    const appPlan = await plan(landofile);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.healthcheck).toEqual({
      kind: "command",
      command: ["curl", "-f", "http://localhost"],
      intervalSeconds: 30,
      timeoutSeconds: 90,
      retries: 3,
      startPeriodSeconds: 3723,
    });
  });

  test("plans a Compose CMD-SHELL healthcheck as a string command", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-shell-healthcheck",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          healthcheck: { test: ["CMD-SHELL", "echo ready"] },
        },
      },
    });

    // When
    const appPlan = await plan(landofile);

    // Then
    const healthcheck = appPlan.services[ServiceName.make("web")]?.healthcheck;
    expect(healthcheck?.command).toBe("echo ready");
    expect(healthcheck?.command).not.toEqual(["sh", "-c", "echo ready"]);
  });

  test("retains a Compose-disabled healthcheck without a command", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-disabled-healthcheck",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          healthcheck: { disable: true },
        },
      },
    });

    // When
    const appPlan = await plan(landofile);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.healthcheck).toEqual({
      kind: "none",
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
    });
  });

  test("preserves raw Compose start_interval only in the compose extension", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-start-interval",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          healthcheck: {
            test: ["CMD", "true"],
            start_interval: "5s",
          },
        },
      },
    });

    // When
    const appPlan = await plan(landofile, composePreservedPathCapabilities);

    // Then
    const servicePlan = appPlan.services[ServiceName.make("web")];
    expect(servicePlan?.extensions).toMatchObject({
      compose: { healthcheck: { start_interval: "5s" } },
    });
    expect(servicePlan?.healthcheck).not.toHaveProperty("startInterval");
    expect(servicePlan?.healthcheck).not.toHaveProperty("startIntervalSeconds");
  });

  test("preserves Compose labels and healthcheck start_interval together", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-healthcheck-and-labels",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          labels: { "io.lando.role": "web" },
          healthcheck: {
            test: ["CMD", "true"],
            start_interval: "5s",
          },
        },
      },
    });

    // When
    const appPlan = await plan(landofile, composePreservedPathCapabilities);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.extensions).toMatchObject({
      compose: {
        labels: { "io.lando.role": "web" },
        healthcheck: { start_interval: "5s" },
      },
    });
  });

  test("uses Lando healthcheck defaults for a Compose healthcheck", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "compose-healthcheck-defaults",
      runtime: 4,
      services: {
        web: {
          image: "node:lts",
          healthcheck: { test: ["CMD", "true"] },
        },
      },
    });

    // When
    const appPlan = await plan(landofile);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.healthcheck).toEqual({
      kind: "command",
      command: ["true"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
    });
  });

  test("applies the resolved base default feature stack alongside resolution and app features", async () => {
    await withTempCwd(async () => {
      // The whole lando base default stack is resolved through the registry;
      // the first default id carries the observable env so the test proves the
      // base defaults are applied, not silently dropped, while the rest are
      // served as no-ops. The service type's own resolution never lists them.
      const observedBaseDefaultId = LANDO_BASE_DEFAULT_FEATURE_IDS[0] ?? "lando.user-id";
      const baseDefaultFeatures = new Map<string, ServiceFeatureDefinition>(
        LANDO_BASE_DEFAULT_FEATURE_IDS.map((id, index) => [
          id,
          {
            id,
            priority: 100 + index,
            apply: (ctx) =>
              Effect.sync(() => {
                if (id === observedBaseDefaultId) ctx.addEnv("BASE_DEFAULT_APPLIED", "1");
              }),
          },
        ]),
      );
      const resolutionFeature: ServiceFeatureDefinition = {
        id: "test.resolution-feature",
        priority: 700,
        apply: (ctx) => Effect.sync(() => ctx.addEnv("RESOLUTION_FEATURE_APPLIED", "1")),
      };
      const serviceType: ServiceType = {
        id: "base-default-backed",
        name: "base-default-backed",
        base: "lando",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "lando" as const,
            normalizedConfig: input.service,
            features: [{ id: resolutionFeature.id }],
          }),
      };
      const appFeature: AppFeatureDefinition = {
        id: "test.base-default-aware",
        priority: 100,
        activatedBy: { services: { type: serviceType.id } },
        selectors: { types: [serviceType.id] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) => service.addEnv("APP_FEATURE_APPLIED", "1"));
          }),
      };
      const features = new Map<string, ServiceFeatureDefinition>([
        ...baseDefaultFeatures,
        [resolutionFeature.id, resolutionFeature],
      ]);
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/base-default"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [serviceType.id], appFeatures: [appFeature.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadServiceFeature: (id: string) => {
          const definition = features.get(id);
          return definition === undefined
            ? Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              )
            : Effect.succeed(definition);
        },
        loadAppFeature: (id: string) =>
          id === appFeature.id
            ? Effect.succeed(appFeature)
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

      const environment = appPlan.services[ServiceName.make("web")]?.environment;
      expect(environment?.BASE_DEFAULT_APPLIED).toBe("1");
      expect(environment?.RESOLUTION_FEATURE_APPLIED).toBe("1");
      expect(environment?.APP_FEATURE_APPLIED).toBe("1");
    });
  });

  test("seeds composed services with normalized primary, host facts, and deduped base defaults", async () => {
    await withTempCwd(async () => {
      const duplicatedDefaultId = LANDO_BASE_DEFAULT_FEATURE_IDS[0] ?? "lando.user-id";
      let duplicatedFeatureApplications = 0;
      const baseDefaultFeatures = new Map<string, ServiceFeatureDefinition>(
        LANDO_BASE_DEFAULT_FEATURE_IDS.map((id, index) => [
          id,
          {
            id,
            priority: 100 + index,
            apply: (ctx) =>
              Effect.sync(() => {
                if (id === duplicatedDefaultId) {
                  duplicatedFeatureApplications += 1;
                  ctx.addEnv("LANDO_HOST_OS", ctx.host?.os ?? "missing");
                }
              }),
          },
        ]),
      );
      const serviceType: ServiceType = {
        id: "compose-seed-backed",
        name: "compose-seed-backed",
        base: "lando",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "lando" as const,
            normalizedConfig: input.service,
            features: [{ id: duplicatedDefaultId }],
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/compose-seed"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [serviceType.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadServiceFeature: (id: string) => {
          const definition = baseDefaultFeatures.get(id);
          return definition === undefined
            ? Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              )
            : Effect.succeed(definition);
        },
      };

      const appPlan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (appPlanner) =>
          appPlanner.plan(
            {
              name: "myapp",
              runtime: 4,
              services: {
                [ServiceName.make("api")]: { type: serviceType.id, primary: true },
              },
            },
            providerLandoCapabilities,
          ),
        ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
      );

      const servicePlan = appPlan.services[ServiceName.make("api")];
      expect(servicePlan?.primary).toBe(true);
      expect(servicePlan?.environment.LANDO_HOST_OS).toBe(process.platform);
      expect(duplicatedFeatureApplications).toBe(1);
    });
  });

  test("exposes base default feature ids to app-feature hasFeature activation", async () => {
    await withTempCwd(async () => {
      const baseOnlyFeatureId = LANDO_BASE_DEFAULT_FEATURE_IDS[1] ?? "lando.storage";
      const baseDefaultFeatures = new Map<string, ServiceFeatureDefinition>(
        LANDO_BASE_DEFAULT_FEATURE_IDS.map((id, index) => [
          id,
          {
            id,
            priority: 100 + index,
            apply: (ctx) =>
              Effect.sync(() => {
                if (id === baseOnlyFeatureId) ctx.addEnv("BASE_ONLY_FEATURE_COMPOSED", "1");
              }),
          },
        ]),
      );
      const compositionGateFeature: ServiceFeatureDefinition = {
        id: "test.composition-gate",
        priority: 900,
        apply: (ctx) => Effect.sync(() => ctx.addEnv("COMPOSITION_GATE", "1")),
      };
      const serviceType: ServiceType = {
        id: "base-default-ids-only",
        name: "base-default-ids-only",
        base: "lando",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "lando" as const,
            normalizedConfig: input.service,
            features: [{ id: compositionGateFeature.id }],
          }),
      };
      const appFeature: AppFeatureDefinition = {
        id: "test.base-default-has-feature",
        priority: 100,
        activatedBy: { services: { hasFeature: baseOnlyFeatureId } },
        selectors: { hasFeature: [baseOnlyFeatureId] },
        apply: (ctx) =>
          Effect.sync(() => {
            ctx.forEachSelected((service) => service.addEnv("ACTIVATED_BY_BASE_DEFAULT", "1"));
          }),
      };
      const features = new Map<string, ServiceFeatureDefinition>([
        ...baseDefaultFeatures,
        [compositionGateFeature.id, compositionGateFeature],
      ]);
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/base-default-ids"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [serviceType.id], appFeatures: [appFeature.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadServiceFeature: (id: string) => {
          const definition = features.get(id);
          return definition === undefined
            ? Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              )
            : Effect.succeed(definition);
        },
        loadAppFeature: (id: string) =>
          id === appFeature.id
            ? Effect.succeed(appFeature)
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

      const environment = appPlan.services[ServiceName.make("web")]?.environment;
      expect(environment?.BASE_ONLY_FEATURE_COMPOSED).toBe("1");
      expect(environment?.ACTIVATED_BY_BASE_DEFAULT).toBe("1");
    });
  });

  test("rolls the app-plan cache key when the resolved feature set changes for the same Landofile", async () => {
    await withTempCwd(async () => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-plan-feature-cache-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;

      // The resolver flips the feature set between runs while the Landofile
      // bytes stay identical: run 1 emits ONE_FEATURE, run 2 emits TWO_FEATURE.
      // A feature-blind cache key would serve run 1's stale plan on run 2.
      let resolveCalls = 0;
      const oneFeature: ServiceFeatureDefinition = {
        id: "test.one-feature",
        priority: 500,
        apply: (ctx) => Effect.sync(() => ctx.addEnv("ONE_FEATURE", "1")),
      };
      const twoFeature: ServiceFeatureDefinition = {
        id: "test.two-feature",
        priority: 500,
        apply: (ctx) => Effect.sync(() => ctx.addEnv("TWO_FEATURE", "1")),
      };
      const features = new Map<string, ServiceFeatureDefinition>([
        [oneFeature.id, oneFeature],
        [twoFeature.id, twoFeature],
      ]);
      const serviceType: ServiceType = {
        id: "feature-flip",
        name: "feature-flip",
        base: "l337",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.sync(() => {
            resolveCalls += 1;
            return {
              base: "l337" as const,
              normalizedConfig: input.service,
              features: [{ id: resolveCalls === 1 ? oneFeature.id : twoFeature.id }],
            };
          }),
      };
      const registry = {
        ...customPluginRegistry,
        list: Effect.succeed([
          Schema.decodeUnknownSync(PluginManifest)({
            name: PluginName.make("@example/feature-flip"),
            version: "1.0.0",
            api: 4 as const,
            contributes: { serviceTypes: [serviceType.id] },
          }),
        ]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadServiceFeature: (id: string) => {
          const definition = features.get(id);
          return definition === undefined
            ? Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              )
            : Effect.succeed(definition);
        },
      };
      const layer = AppPlannerLive.pipe(
        Layer.provide(Layer.mergeAll(CacheServiceLive, Layer.succeed(PluginRegistry, registry))),
      );
      const landofile: LandofileShape = {
        name: "feature-flip-app",
        runtime: 4,
        services: { [ServiceName.make("web")]: { type: serviceType.id } },
      };

      try {
        const runPlan = () =>
          Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerLandoCapabilities)).pipe(
              Effect.provide(layer),
            ),
          );

        const first = await runPlan();
        const second = await runPlan();

        expect(first.services[ServiceName.make("web")]?.environment.ONE_FEATURE).toBe("1");
        expect(first.services[ServiceName.make("web")]?.environment.TWO_FEATURE).toBeUndefined();
        // The feature set changed, so the cache key must roll and re-plan.
        expect(second.services[ServiceName.make("web")]?.environment.TWO_FEATURE).toBe("1");
        expect(second.services[ServiceName.make("web")]?.environment.ONE_FEATURE).toBeUndefined();
        expect(resolveCalls).toBe(2);
      } finally {
        if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  describe("service-type version pinning", () => {
    test("resolves type name:version to name:version by convention when no artifacts entry exists", async () => {
      await withTempCwd(async () => {
        const appPlan = await plan({
          name: "myapp",
          runtime: 4,
          services: {
            [ServiceName.make("db")]: { type: "mariadb:10.11" },
          },
        });
        expect(appPlan.services[ServiceName.make("db")]?.artifact).toEqual({
          kind: "ref",
          ref: "mariadb:10.11",
        });
      });
    });

    test("resolves a colon-bearing service type id as a whole exact match, not name:version", async () => {
      await withTempCwd(async () => {
        const appPlan = await plan({
          name: "myapp",
          runtime: 4,
          services: {
            [ServiceName.make("web")]: { type: "php:8.2" },
          },
        });
        const webPlan = appPlan.services[ServiceName.make("web")];
        expect(webPlan?.type).toBe("php:8.2");
        expect(webPlan?.artifact).toEqual({ kind: "ref", ref: "php:8.2-apache-bookworm" });
      });
    });

    test("rolls the app-plan cache when a version pin changes", async () => {
      await withTempCwd(async () => {
        const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
        const cacheRoot = await mkdtemp(join(tmpdir(), "lando-pin-cache-"));
        process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
        try {
          const runPlan = (version: string) =>
            Effect.runPromise(
              Effect.flatMap(AppPlanner, (appPlanner) =>
                appPlanner.plan(
                  {
                    name: "myapp",
                    runtime: 4,
                    services: { [ServiceName.make("db")]: { type: `mariadb:${version}` } },
                  },
                  providerLandoCapabilities,
                ),
              ).pipe(
                Effect.provide(AppPlannerLive),
                Effect.provide(PluginRegistryLive),
                Effect.provide(CacheServiceLive),
              ),
            );
          const first = await runPlan("10.11");
          const second = await runPlan("11.4");
          expect(first.services[ServiceName.make("db")]?.artifact).toEqual({
            kind: "ref",
            ref: "mariadb:10.11",
          });
          expect(second.services[ServiceName.make("db")]?.artifact).toEqual({
            kind: "ref",
            ref: "mariadb:11.4",
          });
        } finally {
          if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
          else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
          await rm(cacheRoot, { recursive: true, force: true });
        }
      });
    });

    test("does not write an app-plan cache while an unsatisfied version constraint is skipped", async () => {
      await withTempCwd(async (dir) => {
        const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
        const previousSkip = process.env.LANDO_SKIP_VERSION_CONSTRAINT;
        const cacheRoot = await mkdtemp(join(tmpdir(), "lando-skipped-version-plan-cache-"));
        process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
        process.env.LANDO_SKIP_VERSION_CONSTRAINT = "1";
        try {
          const appName = "skip-plan-cache";
          const result = await Effect.runPromise(
            Effect.flatMap(AppPlanner, (appPlanner) =>
              appPlanner.plan(
                {
                  name: appName,
                  runtime: 4,
                  lando: ">=99",
                  services: { [ServiceName.make("web")]: { type: "node:lts" } },
                },
                providerLandoCapabilities,
              ),
            ).pipe(
              Effect.provide(AppPlannerLive),
              Effect.provide(PluginRegistryLive),
              Effect.provide(CacheServiceLive),
            ),
          );

          expect(result.name).toBe(appName);
          expect(await Bun.file(appPlanCachePath(cacheRoot, appName, dir)).exists()).toBe(false);
        } finally {
          if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
          else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
          if (previousSkip === undefined)
            Reflect.deleteProperty(process.env, "LANDO_SKIP_VERSION_CONSTRAINT");
          else process.env.LANDO_SKIP_VERSION_CONSTRAINT = previousSkip;
          await rm(cacheRoot, { recursive: true, force: true });
        }
      });
    });

    test("resolves an exact artifacts entry over the name:version convention", async () => {
      const basePinnedType = makeLegacyServiceTypeFake({
        id: "fake-db",
        toServicePlan: ({ name, service, provider = ProviderId.make("lando"), primary = false, metadata }) =>
          Schema.decodeUnknownSync(ServicePlan)({
            name: ServiceName.make(name),
            type: "fake-db",
            provider,
            primary,
            artifact: { kind: "ref", ref: service.image ?? "fake-db:latest" },
            environment: {},
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
      const pinnedType = {
        ...basePinnedType,
        versions: ["1.0", "2.0"],
        artifacts: { "1.0": "registry.example.com/fake-db:1.0-hardened" },
      };
      const registry = {
        ...customPluginRegistry,
        loadServiceType: (id: string) =>
          id === "fake-db"
            ? Effect.succeed(pinnedType)
            : Effect.fail(
                new PluginLoadError({ message: `Service type ${id} is not registered.`, pluginName: id }),
              ),
        loadServiceFeature: (id: string) =>
          id === basePinnedType.testFeature.id
            ? Effect.succeed(basePinnedType.testFeature)
            : Effect.fail(
                new PluginLoadError({ message: `Service feature ${id} is not registered.`, pluginName: id }),
              ),
      };

      await withTempCwd(async () => {
        const exactPin = await Effect.runPromise(
          Effect.flatMap(AppPlanner, (appPlanner) =>
            appPlanner.plan(
              {
                name: "myapp",
                runtime: 4,
                services: { [ServiceName.make("db")]: { type: "fake-db:1.0" } },
              },
              providerLandoCapabilities,
            ),
          ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
        );
        expect(exactPin.services[ServiceName.make("db")]?.artifact).toEqual({
          kind: "ref",
          ref: "registry.example.com/fake-db:1.0-hardened",
        });

        const conventionPin = await Effect.runPromise(
          Effect.flatMap(AppPlanner, (appPlanner) =>
            appPlanner.plan(
              {
                name: "myapp",
                runtime: 4,
                services: { [ServiceName.make("db")]: { type: "fake-db:2.0" } },
              },
              providerLandoCapabilities,
            ),
          ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
        );
        expect(conventionPin.services[ServiceName.make("db")]?.artifact).toEqual({
          kind: "ref",
          ref: "fake-db:2.0",
        });

        const unsupported = await Effect.runPromiseExit(
          Effect.flatMap(AppPlanner, (appPlanner) =>
            appPlanner.plan(
              {
                name: "myapp",
                runtime: 4,
                services: { [ServiceName.make("db")]: { type: "fake-db:9.9" } },
              },
              providerLandoCapabilities,
            ),
          ).pipe(Effect.provide(AppPlannerLive), Effect.provide(Layer.succeed(PluginRegistry, registry))),
        );
        const failure = expectSomeFailure(unsupported);
        expect(failure).toBeInstanceOf(LandofileValidationError);
        expect((failure as LandofileValidationError).message).toContain("unsupported version");
      });
    });
  });

  test("rejects a required dependency whose target service is absent", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "missing-required-dependency",
      runtime: 4,
      services: {
        web: {
          type: "appmount-only",
          dependsOn: [{ service: "db", condition: "service_started", required: true }],
        },
      },
    });

    // When
    const exit = await planExitWithCustomRegistry(landofile);

    // Then
    const failure = expectSomeFailure(exit);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (failure instanceof LandofileValidationError) {
      expect(failure._tag).toBe("LandofileValidationError");
      expect(failure.issues).toEqual(["services.web.dependsOn"]);
      expect(failure.message).toContain(
        "Service web depends on missing service db with condition service_started.",
      );
      expect(failure.message).toContain("Add service db to services or set required: false");
    }
  });

  test("preserves an optional dependency whose target service is absent", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "missing-optional-dependency",
      runtime: 4,
      services: {
        web: {
          type: "appmount-only",
          dependsOn: [
            {
              service: "db",
              condition: "service_completed_successfully",
              required: false,
            },
          ],
        },
      },
    });

    // When
    const appPlan = await planWithCustomRegistry(landofile);

    // Then
    expect(appPlan.services[ServiceName.make("web")]?.dependsOn).toEqual([
      {
        service: ServiceName.make("db"),
        condition: "service_completed_successfully",
        required: false,
      },
    ]);
  });

  test("rejects a required service_healthy dependency on a target without a healthcheck", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "required-unhealthy-dependency",
      runtime: 4,
      services: {
        web: {
          type: "appmount-only",
          dependsOn: [{ service: "db", condition: "service_healthy", required: true }],
        },
        db: { type: "appmount-only" },
      },
    });

    // When
    const exit = await planExitWithCustomRegistry(landofile);

    // Then
    const failure = expectSomeFailure(exit);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (failure instanceof LandofileValidationError) {
      expect(failure._tag).toBe("LandofileValidationError");
      expect(failure.issues).toEqual(["services.web.dependsOn"]);
      expect(failure.message).toContain(
        "Service web depends on service db with condition service_healthy, but service db has no enabled healthcheck.",
      );
      expect(failure.message).toContain(
        "Add a healthcheck with kind: command to service db, or relax the dependency condition to service_started.",
      );
    }
  });

  test("rejects an optional service_healthy dependency on a target with healthcheck kind none", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "optional-disabled-healthcheck-dependency",
      runtime: 4,
      services: {
        web: {
          type: "appmount-only",
          dependsOn: [{ service: "db", condition: "service_healthy", required: false }],
        },
        db: { type: "appmount-only", healthcheck: { disable: true } },
      },
    });

    // When
    const exit = await planExitWithCustomRegistry(landofile);

    // Then
    const failure = expectSomeFailure(exit);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (failure instanceof LandofileValidationError) {
      expect(failure._tag).toBe("LandofileValidationError");
      expect(failure.issues).toEqual(["services.web.dependsOn"]);
      expect(failure.message).toContain(
        "Service web depends on service db with condition service_healthy, but service db has no enabled healthcheck.",
      );
      expect(failure.message).toContain(
        "Setting required: false only allows the dependency to be missing or fail; it does not make an unsatisfiable condition valid.",
      );
    }
  });

  test("rejects a dependency cycle closed by an optional edge", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "optional-dependency-cycle",
      runtime: 4,
      services: {
        web: {
          type: "appmount-only",
          dependsOn: [{ service: "db", condition: "service_started", required: true }],
        },
        db: {
          type: "appmount-only",
          dependsOn: [
            {
              service: "web",
              condition: "service_completed_successfully",
              required: false,
            },
          ],
        },
      },
    });

    // When
    const exit = await planExitWithCustomRegistry(landofile);

    // Then
    const failure = expectSomeFailure(exit);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (failure instanceof LandofileValidationError) {
      expect(failure._tag).toBe("LandofileValidationError");
      expect(failure.issues).toEqual(["services.db.dependsOn"]);
      expect(failure.message).toContain(
        "web --[service_started]--> db --[service_completed_successfully]--> web",
      );
      expect(failure.message).toContain(
        "Remove or redirect one dependency edge; required: false does not break a dependency cycle.",
      );
    }
  });

  test("rejects a service dependency on itself", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "self-dependency-cycle",
      runtime: 4,
      services: {
        web: {
          type: "appmount-only",
          dependsOn: [{ service: "web", condition: "service_started", required: true }],
        },
      },
    });

    // When
    const exit = await planExitWithCustomRegistry(landofile);

    // Then
    const failure = expectSomeFailure(exit);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    if (failure instanceof LandofileValidationError) {
      expect(failure._tag).toBe("LandofileValidationError");
      expect(failure.issues).toEqual(["services.web.dependsOn"]);
      expect(failure.message).toContain("web --[service_started]--> web");
      expect(failure.message).toContain(
        "Remove or redirect one dependency edge; required: false does not break a dependency cycle.",
      );
    }
  });

  test("validates dependency conditions in a pre-seeded cached plan", async () => {
    await withTempCwd(async (appRoot) => {
      // Given
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-invalid-dependency-cache-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      const appName = "cached-invalid-dependency";
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: appName,
        runtime: 4,
        services: { web: { type: "appmount-only" } },
      });
      const plannerLayer = AppPlannerLive.pipe(
        Layer.provide(Layer.mergeAll(CacheServiceLive, Layer.succeed(PluginRegistry, customPluginRegistry))),
      );

      try {
        const validPlan = await Effect.runPromise(
          Effect.flatMap(AppPlanner, (appPlanner) =>
            appPlanner.plan(landofile, providerLandoCapabilities),
          ).pipe(Effect.provide(plannerLayer)),
        );
        const cachedBytes = await readFile(appPlanCachePath(cacheRoot, appName, appRoot));
        const cachedPayload = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
          deserialize(cachedBytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
        );
        const web = validPlan.services[ServiceName.make("web")];
        if (web === undefined) throw new Error("Expected cached web service plan");
        const invalidPlan: AppPlan = {
          ...validPlan,
          services: {
            ...validPlan.services,
            [ServiceName.make("web")]: {
              ...web,
              dependsOn: [
                {
                  service: ServiceName.make("db"),
                  condition: "service_started",
                  required: true,
                },
              ],
            },
          },
        };
        await Effect.runPromise(
          writeCachedAppPlan({
            cacheRoot,
            appName,
            appRoot,
            key: cachedPayload.key,
            plan: invalidPlan,
          }).pipe(Effect.provide(CacheServiceLive)),
        );

        // When
        const exit = await Effect.runPromiseExit(
          Effect.flatMap(AppPlanner, (appPlanner) =>
            appPlanner.plan(landofile, providerLandoCapabilities),
          ).pipe(Effect.provide(plannerLayer)),
        );

        // Then
        const failure = expectSomeFailure(exit);
        expect(failure).toBeInstanceOf(LandofileValidationError);
        if (failure instanceof LandofileValidationError) {
          expect(failure._tag).toBe("LandofileValidationError");
          expect(failure.issues).toEqual(["services.web.dependsOn"]);
          expect(failure.message).toContain(
            "Service web depends on missing service db with condition service_started.",
          );
          expect(failure.message).toContain("Add service db to services or set required: false");
        }
      } finally {
        if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });
});

const allKnobEncodedService = {
  image: "node:lts",
  restart: "unless-stopped",
  cap_add: "NET_ADMIN",
  cap_drop: ["MKNOD"],
  privileged: true,
  devices: ["/dev/fuse:/dev/fuse:rwm"],
  ulimits: { nofile: 4096 },
  sysctls: ["net.core.somaxconn=1024"],
  tmpfs: "/run",
  shm_size: "64m",
  dns: "1.1.1.1",
  dns_search: ["example.test"],
  dns_opt: ["ndots:2"],
  extra_hosts: ["host.docker.internal:host-gateway"],
  init: true,
  stop_signal: "SIGTERM",
  stop_grace_period: "30s",
  security_opt: ["no-new-privileges:true"],
  group_add: ["docker"],
  read_only: true,
  platform: "linux/amd64",
  pull_policy: "always",
  logging: { driver: "json-file", options: { "max-size": "10m" } },
  gpus: "all",
  deploy: { resources: { limits: { cpus: "0.5", memory: "512m", pids: 100 } } },
} as const;

const allKnobLandofile = Schema.decodeUnknownSync(LandofileShape)({
  name: "allknobs",
  runtime: 4,
  services: { web: allKnobEncodedService },
});

const allKnobServiceConfig = allKnobLandofile.services[ServiceName.make("web")] as Record<string, unknown>;

const allKnobExtensionKeys = Object.keys(allKnobEncodedService).filter((key) => key !== "image");

const allKnobCapabilities: ProviderCapabilities = {
  ...providerLandoCapabilities,
  composeKnobs: {
    supported: [
      "restart",
      "cap_add",
      "cap_drop",
      "privileged",
      "devices",
      "ulimits",
      "sysctls",
      "tmpfs",
      "shm_size",
      "dns",
      "dns_search",
      "dns_opt",
      "extra_hosts",
      "init",
      "stop_signal",
      "stop_grace_period",
      "security_opt",
      "group_add",
      "read_only",
      "platform",
      "pull_policy",
      "logging",
      "gpus",
      "deploy.resources",
    ],
  },
};

describe("Compose runtime knobs", () => {
  test("Given authored Compose runtime knobs, when the app is planned, then they reach the service plan compose extension", async () => {
    // Given
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "knobapp",
      runtime: 4,
      services: { web: { image: "node:lts", restart: "unless-stopped", shm_size: "64m" } },
    });

    await withTempCwd(async () => {
      // When
      const appPlan = await plan(landofile, allKnobCapabilities);

      // Then
      expect(appPlan.services[ServiceName.make("web")]?.extensions.compose).toMatchObject({
        restart: "unless-stopped",
        shm_size: 67_108_864,
      });
    });
  });

  test("Given every preserved knob key, when the app is planned twice, then each canonicalized value survives byte-identically", async () => {
    await withTempCwd(async () => {
      // When
      const first = await plan(allKnobLandofile, allKnobCapabilities);
      const second = await plan(allKnobLandofile, allKnobCapabilities);
      const compose = first.services[ServiceName.make("web")]?.extensions.compose as
        | Record<string, unknown>
        | undefined;

      // Then
      expect(Object.keys(compose ?? {}).sort()).toEqual([...allKnobExtensionKeys].sort());
      for (const key of allKnobExtensionKeys) {
        expect(JSON.stringify(compose?.[key])).toBe(JSON.stringify(allKnobServiceConfig[key]));
      }
      expect(JSON.stringify(second.services[ServiceName.make("web")]?.extensions.compose)).toBe(
        JSON.stringify(compose),
      );
    });
  });

  const knobLandofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "knobapp",
    runtime: 4,
    services: { web: { image: "node:lts", restart: "unless-stopped", shm_size: "64m" } },
  });

  test("Given the partial test-provider declaration, when only supported knobs are planned, then planning succeeds", async () => {
    await withTempCwd(async () => {
      // When
      const appPlan = await plan(knobLandofile, TestRuntimeProvider.capabilities);

      // Then
      expect(appPlan.services[ServiceName.make("web")]?.extensions.compose).toMatchObject({
        restart: "unless-stopped",
        shm_size: 67_108_864,
      });
    });
  });

  test("Given a provider that omits a used knob, when the app is planned, then planning fails naming the service and knob", async () => {
    const unsupportedKnobLandofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "knobapp",
      runtime: 4,
      services: { web: { image: "node:lts", restart: "unless-stopped", read_only: true } },
    });

    await withTempCwd(async () => {
      // When
      const exit = await planExit(unsupportedKnobLandofile, TestRuntimeProvider.capabilities);

      // Then
      const failure = expectSomeFailure(exit);
      expect(failure).toBeInstanceOf(CapabilityError);
      expect(failure).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "read_only",
        capability: "composeSpec",
        providerId: "lando",
      });
      expect(failure instanceof CapabilityError ? failure.remediation : undefined).toContain("read_only");
    });
  });

  test("Given a native provider with no knob declaration, when a knob is used, then planning fails closed", async () => {
    await withTempCwd(async () => {
      // When
      const exit = await planExit(knobLandofile, providerLandoCapabilities);

      // Then
      expect(expectSomeFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "restart",
        capability: "composeSpec",
      });
    });
  });

  test("Given a portable provider that declares knobs, when a knob is used, then the tier gate still rejects it", async () => {
    await withTempCwd(async () => {
      // When
      const exit = await planExit(knobLandofile, {
        ...providerLandoCapabilities,
        composeSpec: "portable",
        composeKnobs: { supported: ["restart", "shm_size"] },
      });

      // Then
      expect(expectSomeFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "restart",
        capability: "composeSpec",
      });
    });
  });

  const tmpfsInjectingServiceType = makeLegacyServiceTypeFake({
    id: "tmpfs-injecting",
    toServicePlan: ({ name, provider = ProviderId.make("lando"), primary = false, metadata }) =>
      Schema.decodeUnknownSync(ServicePlan)({
        name: ServiceName.make(name),
        type: "tmpfs-injecting",
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
        extensions: { compose: { tmpfs: ["/run"] } },
      }),
  });

  const injectedLandofile: LandofileShape = {
    name: "injected-knobs",
    runtime: 4,
    services: { [ServiceName.make("web")]: { type: "tmpfs-injecting" } },
  };

  const tmpfsInjectingRegistry = {
    ...registryWithServiceType(tmpfsInjectingServiceType),
    loadServiceFeature: (id: string) =>
      id === tmpfsInjectingServiceType.testFeature.id
        ? Effect.succeed(tmpfsInjectingServiceType.testFeature)
        : customPluginRegistry.loadServiceFeature(id),
  };

  const planInjectedExit = (providerCapabilities: ProviderCapabilities) =>
    Effect.runPromiseExit(
      Effect.flatMap(AppPlanner, (appPlanner) =>
        appPlanner.plan(injectedLandofile, providerCapabilities),
      ).pipe(
        Effect.provide(AppPlannerLive),
        Effect.provide(Layer.succeed(PluginRegistry, tmpfsInjectingRegistry)),
      ),
    );

  test("Given a knob injected by a plugin rather than authored, when the app is planned, then it is still capability-gated", async () => {
    await withTempCwd(async () => {
      // When
      const exit = await planInjectedExit(providerLandoCapabilities);

      // Then
      expect(expectSomeFailure(exit)).toMatchObject({
        _tag: "CapabilityError",
        service: "web",
        key: "tmpfs",
        capability: "composeSpec",
      });
    });
  });

  test("Given a provider declaring the injected knob, when the app is planned, then planning succeeds", async () => {
    await withTempCwd(async () => {
      // When
      const exit = await planInjectedExit(allKnobCapabilities);

      // Then
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("Given a plan cached under a permissive provider, when a restrictive provider replans, then the cached plan does not bypass the gate", async () => {
    await withTempCwd(async () => {
      // Given
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-knob-cache-root-")));
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      const cachedLayer = AppPlannerLive.pipe(
        Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, PluginRegistryLive)),
      );
      const runPlan = (providerCapabilities: ProviderCapabilities) =>
        Effect.runPromiseExit(
          Effect.flatMap(AppPlanner, (appPlanner) =>
            appPlanner.plan(knobLandofile, providerCapabilities),
          ).pipe(Effect.provide(cachedLayer)),
        );

      try {
        const first = await runPlan(allKnobCapabilities);
        const second = await runPlan(allKnobCapabilities);

        // The second permissive run must be served from the cache, otherwise the
        // restrictive run below would never exercise the cached-plan path.
        expect(Exit.isSuccess(first) && Exit.isSuccess(second)).toBe(true);
        if (Exit.isSuccess(first) && Exit.isSuccess(second)) {
          expect(second.value.metadata.resolvedAt).toEqual(first.value.metadata.resolvedAt);
        }
        await readFile(appPlanCachePath(cacheRoot, "knobapp", process.cwd()));

        // When
        const restrictive = await runPlan({
          ...providerLandoCapabilities,
          composeKnobs: { supported: ["restart"] },
        });

        // Then
        expect(expectSomeFailure(restrictive)).toMatchObject({
          _tag: "CapabilityError",
          service: "web",
          key: "shm_size",
          capability: "composeSpec",
          providerId: "lando",
        });
      } finally {
        if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
        else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });
});
