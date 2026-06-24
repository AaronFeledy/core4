import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer, Queue, Stream } from "effect";

import { runTooling } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  ConfigService,
  EventService,
  type LandoEvent,
  LandofileService,
  PluginRegistry,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";

import {
  deriveAppPlanCacheKey,
  readAppPlanSourceFingerprint,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../../src/cache/app-plan.ts";
import { CacheServiceLive } from "../../src/cache/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { ProviderExecToolingEngineLive } from "../../src/services/tooling-engine.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
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
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
  source: "tooling.scenario.test",
  runtime: 4 as const,
};

const makeService = (name: string, primary = false): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: undefined,
  entrypoint: undefined,
  environment: {},
  user: undefined,
  workingDirectory: undefined,
  appMount: undefined,
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  healthcheck: undefined,
  certs: undefined,
  hostAliases: [],
  metadata,
  extensions: {},
});

const makePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  id: AppId.make("scenario"),
  name: "scenario",
  slug: "scenario",
  root: AbsolutePath.make("/tmp/scenario"),
  provider: providerId,
  services: Object.fromEntries(
    services.map((service) => [String(service.name), service]),
  ) as AppPlan["services"],
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

interface ExecRecord {
  readonly service: string;
  readonly command: ReadonlyArray<string>;
}

const makeProvider = (
  responses: ReadonlyArray<{ exitCode: number; stdout?: string; stderr?: string }>,
): { provider: RuntimeProviderShape; calls: ReadonlyArray<ExecRecord> } => {
  const calls: ExecRecord[] = [];
  let i = 0;
  const provider: RuntimeProviderShape = {
    id: providerId,
    displayName: "Fake",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "buildArtifact",
          message: "n/a",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "pullArtifact",
          message: "n/a",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: (target, spec) => {
      calls.push({ service: String(target.service), command: spec.command });
      const response = responses[i] ?? { exitCode: 0 };
      i += 1;
      return Effect.succeed({
        exitCode: response.exitCode,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      });
    },
    execStream: () => Stream.empty,
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.empty,
    inspect: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "inspect", message: "n/a" })),
    list: () => Effect.succeed([]),
  };
  return { provider, calls };
};

const makeLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
  readonly planCalls?: number[];
  readonly planCwds?: string[];
}) => {
  const landofileLayer = Layer.succeed(LandofileService, {
    discover: Effect.succeed(options.landofile),
  });
  const plannerLayer = Layer.succeed(AppPlanner, {
    plan: () => {
      options.planCalls?.push(1);
      options.planCwds?.push(process.cwd());
      return Effect.succeed(options.plan);
    },
  });
  const registryLayer = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(options.provider),
  });
  return Layer.mergeAll(landofileLayer, plannerLayer, registryLayer, ProviderExecToolingEngineLive);
};

const emptyPluginRegistry = Layer.succeed(PluginRegistry, {
  list: Effect.succeed([]),
  load: () => Effect.die("not used"),
  loadServiceType: () => Effect.die("not used"),
  loadServiceFeature: () => Effect.die("not used"),
});

const withTempToolingApp = async <T>(run: (root: string, cacheRoot: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-tooling-plan-cache-app-"));
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-tooling-plan-cache-root-"));
  const previousCwd = process.cwd();
  try {
    await writeFile(join(root, ".lando.yml"), "name: scenario\n");
    process.chdir(root);
    return await run(root, cacheRoot);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const cachedPlanKey = async (
  landofile: LandofileShape,
  appRoot: string,
  provider: RuntimeProviderShape,
): Promise<string> =>
  deriveAppPlanCacheKey({
    appRoot,
    landofile: { ...landofile, provider: String(provider.id) },
    pluginManifests: [],
    sourceFingerprint: await Effect.runPromise(readAppPlanSourceFingerprint(appRoot)),
  });

const bundledPluginPlanKey = async (
  landofile: LandofileShape,
  appRoot: string,
  provider: RuntimeProviderShape,
): Promise<string> => {
  const pluginManifests = await Effect.runPromise(
    Effect.gen(function* () {
      const pluginRegistry = yield* PluginRegistry;
      return yield* pluginRegistry.list;
    }).pipe(Effect.provide(PluginRegistryLive)),
  );
  return deriveAppPlanCacheKey({
    appRoot,
    landofile: { ...landofile, provider: String(provider.id) },
    pluginManifests,
    sourceFingerprint: await Effect.runPromise(readAppPlanSourceFingerprint(appRoot)),
  });
};

const cacheAwareLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
  readonly planCalls?: number[];
  readonly planCwds?: string[];
}) => Layer.mergeAll(makeLayer(options), emptyPluginRegistry, CacheServiceLive);

const configLayer = (defaultProviderId: string | null) =>
  Layer.succeed(ConfigService, {
    get: (key: string) =>
      Effect.succeed(
        key === "defaultProviderId"
          ? defaultProviderId === null
            ? null
            : ProviderId.make(defaultProviderId)
          : undefined,
      ),
  });

const recordingEventLayer = (events: LandoEvent[]) =>
  Layer.effect(
    EventService,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<LandoEvent>();
      return {
        publish: (event: LandoEvent) =>
          Effect.gen(function* () {
            events.push(event);
            yield* Queue.offer(queue, event);
          }),
        subscribe: (name: string) =>
          Stream.fromQueue(queue).pipe(Stream.filter((event) => name === "*" || event._tag === name)),
        subscribeQueue: Effect.succeed(queue),
        waitFor: () => Effect.die("not used"),
      };
    }),
  );

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
};

const runtimeFor = (layer: Layer.Layer<never, never, never>) => Effect.provide(layer);

describe("runTooling — CLI rendering", () => {
  test("publishes task-tree events for successful provider-exec tooling output", async () => {
    const events: LandoEvent[] = [];
    const { provider } = makeProvider([{ exitCode: 0, stdout: "installing\ndone\n" }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer install" } },
    };
    const layer = Layer.mergeAll(
      makeLayer({ landofile, plan: makePlan([makeService("appserver", true)]), provider }),
      recordingEventLayer(events),
    );

    const result = await Effect.runPromise(
      runTooling({ name: "composer", renderProgress: true }).pipe(runtimeFor(layer)),
    );

    expect(result.exitCode).toBe(0);
    expect(events.map((event) => event._tag)).toEqual([
      "task.tree.start",
      "task.start",
      "task.detail",
      "task.detail",
      "task.complete",
      "task.tree.complete",
    ]);
    expect(events.find((event) => event._tag === "task.tree.start")).toMatchObject({
      parentId: "tooling:composer",
      label: "Tooling: composer",
      children: ["tooling:composer:appserver"],
    });
    expect(events.filter((event) => event._tag === "task.detail")).toEqual([
      expect.objectContaining({ taskId: "tooling:composer:appserver", stream: "stdout", line: "installing" }),
      expect.objectContaining({ taskId: "tooling:composer:appserver", stream: "stdout", line: "done" }),
    ]);
    expect(events.find((event) => event._tag === "task.complete")).toMatchObject({
      taskId: "tooling:composer:appserver",
      summary: "completed with exit code 0",
    });
    expect(events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      parentId: "tooling:composer",
      succeeded: 1,
      failed: 0,
    });
  });

  test("publishes stderr detail and task.fail for non-zero provider-exec tooling", async () => {
    const events: LandoEvent[] = [];
    const { provider } = makeProvider([{ exitCode: 7, stdout: "before\n", stderr: "boom\n" }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer install" } },
    };
    const layer = Layer.mergeAll(
      makeLayer({ landofile, plan: makePlan([makeService("appserver", true)]), provider }),
      recordingEventLayer(events),
    );

    const result = await Effect.runPromise(
      runTooling({ name: "composer", renderProgress: true }).pipe(runtimeFor(layer)),
    );

    expect(result.exitCode).toBe(7);
    expect(events.find((event) => event._tag === "task.detail" && event.stream === "stderr")).toMatchObject({
      taskId: "tooling:composer:appserver",
      line: "boom",
    });
    expect(events.find((event) => event._tag === "task.fail")).toMatchObject({
      taskId: "tooling:composer:appserver",
      summary: "failed with exit code 7",
      exitCode: 7,
    });
    expect(events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      parentId: "tooling:composer",
      succeeded: 0,
      failed: 1,
    });
  });

  test("reads the app plan from cache before falling back to AppPlanner", async () => {
    await withTempToolingApp(async (root, cacheRoot) => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      try {
        const cachedPlan = { ...makePlan([makeService("appserver", true)]), root: AbsolutePath.make(root) };
        const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "cached-plan\n" }]);
        const landofile: LandofileShape = {
          name: "scenario",
          tooling: { composer: { service: "appserver", cmd: "composer" } },
        };
        const key = await cachedPlanKey(landofile, root, provider);
        await Effect.runPromise(
          writeCachedAppPlan({
            cacheRoot,
            appName: "scenario",
            appRoot: root,
            key,
            plan: cachedPlan,
            now: () => 1,
          }).pipe(Effect.provide(CacheServiceLive)),
        );

        const layer = Layer.mergeAll(
          Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
          Layer.succeed(AppPlanner, { plan: () => Effect.die("cache hit must not plan") }),
          Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.succeed([providerId]),
            capabilities: Effect.die("cache hit must not read provider capabilities"),
            select: (planArg?: AppPlan) =>
              planArg === undefined
                ? Effect.die("cache hit must not select provider before reading the plan cache")
                : Effect.succeed(provider),
          }),
          ProviderExecToolingEngineLive,
          emptyPluginRegistry,
          CacheServiceLive,
        );

        const result = await Effect.runPromise(
          runTooling({ name: "composer", cacheRoot }).pipe(runtimeFor(layer)),
        );

        expect(result.stdout).toBe("cached-plan\n");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.service).toBe("appserver");
      } finally {
        restoreEnv("LANDO_USER_CACHE_ROOT", previousCacheRoot);
      }
    });
  });

  test("reads planner-compatible cache entries keyed by bundled plugin manifests", async () => {
    await withTempToolingApp(async (root, cacheRoot) => {
      const cachedPlan = { ...makePlan([makeService("appserver", true)]), root: AbsolutePath.make(root) };
      const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "bundled-cache\n" }]);
      const landofile: LandofileShape = {
        name: "scenario",
        tooling: { composer: { service: "appserver", cmd: "composer" } },
      };
      await Effect.runPromise(
        writeCachedAppPlan({
          cacheRoot,
          appName: "scenario",
          appRoot: root,
          key: await bundledPluginPlanKey(landofile, root, provider),
          plan: cachedPlan,
          now: () => 1,
        }).pipe(Effect.provide(CacheServiceLive)),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
        Layer.succeed(AppPlanner, { plan: () => Effect.die("bundled cache hit must not plan") }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([providerId]),
          capabilities: Effect.die("bundled cache hit must not read provider capabilities"),
          select: (planArg?: AppPlan) =>
            planArg === undefined
              ? Effect.die("bundled cache hit must not select provider before reading cache")
              : Effect.succeed(provider),
        }),
        ProviderExecToolingEngineLive,
        PluginRegistryLive,
        CacheServiceLive,
      );

      const result = await Effect.runPromise(
        runTooling({ name: "composer", cacheRoot }).pipe(runtimeFor(layer)),
      );

      expect(result.stdout).toBe("bundled-cache\n");
      expect(calls[0]?.service).toBe("appserver");
    });
  });

  test("falls back to AppPlanner on cache miss and repopulates the app-plan cache", async () => {
    await withTempToolingApp(async (root, cacheRoot) => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      try {
        const planned = { ...makePlan([makeService("appserver", true)]), root: AbsolutePath.make(root) };
        const { provider } = makeProvider([{ exitCode: 0, stdout: "planned\n" }]);
        const landofile: LandofileShape = {
          name: "scenario",
          tooling: { composer: { service: "appserver", cmd: "composer" } },
        };
        const planCalls: number[] = [];
        const planCwds: string[] = [];
        const subdir = join(root, "subdir");
        await mkdir(subdir);
        process.chdir(subdir);
        const layer = cacheAwareLayer({ landofile, plan: planned, provider, planCalls, planCwds });

        const result = await Effect.runPromise(
          runTooling({ name: "composer", cacheRoot }).pipe(runtimeFor(layer)),
        );
        const key = await cachedPlanKey(landofile, root, provider);
        const cached = await Effect.runPromise(
          readCachedAppPlan({ cacheRoot, appName: "scenario", appRoot: root, key }),
        );

        expect(result.stdout).toBe("planned\n");
        expect(planCalls).toHaveLength(1);
        expect(planCwds).toEqual([root]);
        expect(cached?.name).toBe("scenario");
      } finally {
        restoreEnv("LANDO_USER_CACHE_ROOT", previousCacheRoot);
      }
    });
  });

  test("bypasses the app-plan cache when plugin manifests cannot be enumerated", async () => {
    await withTempToolingApp(async (root, cacheRoot) => {
      const cachedPlan = { ...makePlan([makeService("cached", true)]), root: AbsolutePath.make(root) };
      const freshPlan = { ...makePlan([makeService("appserver", true)]), root: AbsolutePath.make(root) };
      const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "fresh\n" }]);
      const landofile: LandofileShape = {
        name: "scenario",
        tooling: { composer: { service: "appserver", cmd: "composer" } },
      };
      await Effect.runPromise(
        writeCachedAppPlan({
          cacheRoot,
          appName: "scenario",
          appRoot: root,
          key: await cachedPlanKey(landofile, root, provider),
          plan: cachedPlan,
          now: () => 1,
        }).pipe(Effect.provide(CacheServiceLive)),
      );
      const planCalls: number[] = [];
      const layer = Layer.mergeAll(
        makeLayer({ landofile, plan: freshPlan, provider, planCalls }),
        Layer.succeed(PluginRegistry, {
          list: Effect.fail(new Error("plugin registry unavailable")),
          load: () => Effect.die("not used"),
          loadServiceType: () => Effect.die("not used"),
          loadServiceFeature: () => Effect.die("not used"),
        }),
        CacheServiceLive,
      );

      const result = await Effect.runPromise(
        runTooling({ name: "composer", cacheRoot }).pipe(runtimeFor(layer)),
      );

      expect(result.stdout).toBe("fresh\n");
      expect(planCalls).toHaveLength(1);
      expect(calls[0]?.service).toBe("appserver");
    });
  });

  test("uses the configured default provider id when reading a warm app-plan cache", async () => {
    await withTempToolingApp(async (root, cacheRoot) => {
      const configuredProviderId = ProviderId.make("docker");
      const cachedPlan = {
        ...makePlan([makeService("appserver", true)]),
        root: AbsolutePath.make(root),
        provider: configuredProviderId,
      };
      const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "configured-cache\n" }]);
      const landofile: LandofileShape = {
        name: "scenario",
        tooling: { composer: { service: "appserver", cmd: "composer" } },
      };
      const key = deriveAppPlanCacheKey({
        appRoot: root,
        landofile: { ...landofile, provider: configuredProviderId },
        pluginManifests: [],
        sourceFingerprint: await Effect.runPromise(readAppPlanSourceFingerprint(root)),
      });
      await Effect.runPromise(
        writeCachedAppPlan({
          cacheRoot,
          appName: "scenario",
          appRoot: root,
          key,
          plan: cachedPlan,
          now: () => 1,
        }).pipe(Effect.provide(CacheServiceLive)),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
        Layer.succeed(AppPlanner, { plan: () => Effect.die("config cache hit must not plan") }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([configuredProviderId]),
          capabilities: Effect.die("config cache hit must not read provider capabilities"),
          select: (planArg?: AppPlan) =>
            planArg === undefined
              ? Effect.die("config cache hit must not select provider before reading cache")
              : Effect.succeed(provider),
        }),
        ProviderExecToolingEngineLive,
        emptyPluginRegistry,
        configLayer("docker"),
        CacheServiceLive,
      );

      const result = await Effect.runPromise(
        runTooling({ name: "composer", cacheRoot }).pipe(runtimeFor(layer)),
      );

      expect(result.stdout).toBe("configured-cache\n");
      expect(calls[0]?.service).toBe("appserver");
    });
  });

  test("ignores stale app-plan cache entries and replaces them after fallback planning", async () => {
    await withTempToolingApp(async (root, cacheRoot) => {
      const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
      process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
      try {
        const stalePlan = {
          ...makePlan([makeService("stale", true)]),
          root: AbsolutePath.make(root),
          provider: ProviderId.make("docker"),
        };
        const freshPlan = { ...makePlan([makeService("fresh", true)]), root: AbsolutePath.make(root) };
        const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "fresh\n" }]);
        const staleLandofile: LandofileShape = {
          name: "scenario",
          services: { web: { type: "node", environment: { NODE_ENV: "stale" } } },
          tooling: { test: { cmd: "bun test" } },
        };
        const landofile: LandofileShape = {
          name: "scenario",
          tooling: { test: { cmd: "bun test" } },
        };
        const staleKey = await cachedPlanKey(staleLandofile, root, provider);
        await Effect.runPromise(
          writeCachedAppPlan({
            cacheRoot,
            appName: "scenario",
            appRoot: root,
            key: staleKey,
            plan: stalePlan,
            now: () => 1,
          }).pipe(Effect.provide(CacheServiceLive)),
        );
        const planCalls: number[] = [];
        const layer = cacheAwareLayer({ landofile, plan: freshPlan, provider, planCalls });

        const result = await Effect.runPromise(
          runTooling({ name: "test", cacheRoot }).pipe(runtimeFor(layer)),
        );
        const freshKey = await cachedPlanKey(landofile, root, provider);
        const refreshed = await Effect.runPromise(
          readCachedAppPlan({ cacheRoot, appName: "scenario", appRoot: root, key: freshKey }),
        );

        expect(result.stdout).toBe("fresh\n");
        expect(planCalls).toHaveLength(1);
        expect(calls[0]?.service).toBe("fresh");
        expect(refreshed?.provider).toBe(providerId);
      } finally {
        restoreEnv("LANDO_USER_CACHE_ROOT", previousCacheRoot);
      }
    });
  });

  test("returns the verbatim exit code, stdout, and stderr from RuntimeProvider.exec", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 5, stdout: "out-1\nout-2\n", stderr: "err-1\n" }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "composer", args: ["install"] }).pipe(runtimeFor(layer)),
    );

    expect(result.tool).toBe("composer");
    expect(result.service).toBe("appserver");
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("out-1\nout-2\n");
    expect(result.stderr).toBe("err-1\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("appserver");
    expect(calls[0]?.command).toEqual(["sh", "-c", "composer install"]);
  });

  test("appends pass-through args to argv-form cmd", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: {
        phpunit: {
          service: "appserver",
          cmd: ["phpunit", "--colors=always"],
        },
      },
    };
    const layer = makeLayer({ landofile, plan, provider });

    await Effect.runPromise(runTooling({ name: "phpunit", args: ["--testdox"] }).pipe(runtimeFor(layer)));

    expect(calls[0]?.command).toEqual(["phpunit", "--colors=always", "--testdox"]);
  });

  test("runs each entry in cmds: sequentially under sh -c, appending args to the last entry only", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([
      { exitCode: 0, stdout: "install-out\n" },
      { exitCode: 0, stdout: "test-out\n" },
    ]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: {
        test: {
          service: "appserver",
          cmds: ["composer install", "phpunit"],
        },
      },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "test", args: ["--testdox"] }).pipe(runtimeFor(layer)),
    );

    expect(calls.map((call) => call.command)).toEqual([
      ["sh", "-c", "composer install"],
      ["sh", "-c", "phpunit --testdox"],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("install-out\ntest-out\n");
  });

  test("fails fast with ToolingCompileError on unknown tooling command", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const exit = await Effect.runPromiseExit(runTooling({ name: "missing" }).pipe(runtimeFor(layer)));

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
    if (exit._tag !== "Failure") return;
    const flat = JSON.stringify(exit.cause);
    expect(flat).toContain("ToolingCompileError");
    expect(flat).toContain("missing");
  });

  test("fails with ToolingExecError when the task has neither cmd nor cmds", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { empty: { service: "appserver" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const exit = await Effect.runPromiseExit(runTooling({ name: "empty" }).pipe(runtimeFor(layer)));

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  test("does NOT write stderr to process.stderr directly — result.stderr is returned for the CLI boundary to render", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider } = makeProvider([{ exitCode: 1, stdout: "", stderr: "boom\n" }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await Effect.runPromise(runTooling({ name: "composer" }).pipe(runtimeFor(layer)));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("boom\n");
      expect(writes).toHaveLength(0);
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
  });

  test("resolves to the primary service when the task does not declare service:", async () => {
    const plan = makePlan([makeService("web", true), makeService("database")]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { test: { cmd: "bun test" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    await Effect.runPromise(runTooling({ name: "test" }).pipe(runtimeFor(layer)));

    expect(calls[0]?.service).toBe("web");
  });

  test("fails with ToolingExecError when the task does not declare service: and the app has no primary", async () => {
    const plan = makePlan([makeService("database"), makeService("cache")]);
    const { provider } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { test: { cmd: "bun test" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const exit = await Effect.runPromiseExit(runTooling({ name: "test" }).pipe(runtimeFor(layer)));

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(JSON.stringify(exit.cause)).toContain("ToolingExecError");
  });
});

const withAppRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-tooling-scenario-bun-sh-"));
  const previousCwd = process.cwd();
  try {
    await writeFile(join(root, ".lando.yml"), "name: scenario\n");
    process.chdir(root);
    return await run(root);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
};

const writeBunShScript = async (appRoot: string, relativePath: string, contents: string): Promise<string> => {
  const target = join(appRoot, ".lando", "scripts", relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
  return target;
};

describe("runTooling — .bun.sh script-backed tasks", () => {
  test("runs a .lando/scripts/<name>.bun.sh task through the host engine and returns its output", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "greet.bun.sh",
        ["# ---", "# desc: Print a greeting", "# ---", "echo -n 'hi-from-bun-sh'", ""].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider, calls } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = makeLayer({ landofile, plan, provider });

      const result = await Effect.runPromise(runTooling({ name: "greet" }).pipe(runtimeFor(layer)));

      expect(result.tool).toBe("app:greet");
      expect(result.service).toBe(":host");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hi-from-bun-sh");
      expect(calls).toHaveLength(0);
    });
  });

  test("publishes task-tree events for successful .bun.sh host tooling output", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "greet.bun.sh",
        ["# ---", "# desc: Print a greeting", "# ---", "echo 'hi-from-bun-sh'", ""].join("\n"),
      );

      const events: LandoEvent[] = [];
      const plan = makePlan([makeService("appserver", true)]);
      const { provider } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = Layer.mergeAll(makeLayer({ landofile, plan, provider }), recordingEventLayer(events));

      const result = await Effect.runPromise(
        runTooling({ name: "greet", renderProgress: true }).pipe(runtimeFor(layer)),
      );

      expect(result.service).toBe(":host");
      expect(events.map((event) => event._tag)).toEqual([
        "task.tree.start",
        "task.start",
        "task.detail",
        "task.complete",
        "task.tree.complete",
      ]);
      expect(events.find((event) => event._tag === "task.detail")).toMatchObject({
        taskId: "tooling:app:greet::host",
        stream: "stdout",
        line: "hi-from-bun-sh",
      });
    });
  });

  test("matches nested script paths to colon-separated canonical ids", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        join("db", "wait.bun.sh"),
        ["# ---", "# desc: Wait for the DB", "# ---", "echo -n 'db-ok'", ""].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider, calls } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = makeLayer({ landofile, plan, provider });

      const result = await Effect.runPromise(runTooling({ name: "db:wait" }).pipe(runtimeFor(layer)));

      expect(result.tool).toBe("app:db:wait");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("db-ok");
      expect(calls).toHaveLength(0);
    });
  });

  test("propagates non-zero exit codes from a failing .bun.sh task as ToolingExecError with the script exit code", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "fail.bun.sh",
        ["# ---", "# desc: Fail on purpose", "# ---", "exit 7", ""].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = makeLayer({ landofile, plan, provider });

      const exit = await Effect.runPromiseExit(runTooling({ name: "fail" }).pipe(runtimeFor(layer)));
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      const flat = JSON.stringify(exit.cause);
      expect(flat).toContain("ToolingExecError");
      expect(flat).toContain('"exitCode":7');
    });
  });

  test("Landofile tooling.<id> overrides an auto-discovered script and routes through providerExec", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "build.bun.sh",
        [
          "# ---",
          "# desc: Script-backed build (should be overridden)",
          "# ---",
          "process.stdout.write('from-script');",
          "",
        ].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "from-provider" }]);
      const landofile: LandofileShape = {
        name: "scenario",
        tooling: { build: { service: "appserver", cmd: "make" } },
      };
      const layer = makeLayer({ landofile, plan, provider });

      const result = await Effect.runPromise(runTooling({ name: "build" }).pipe(runtimeFor(layer)));

      expect(result.service).toBe("appserver");
      expect(result.stdout).toBe("from-provider");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toEqual(["sh", "-c", "make"]);
    });
  });

  test("Landofile tooling.<id> wins over a script even when the user invokes with the canonical app:<id> form", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "build.bun.sh",
        [
          "# ---",
          "# desc: Script-backed build (must NOT run for app:build)",
          "# ---",
          "echo from-script",
          "",
        ].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "from-provider" }]);
      const landofile: LandofileShape = {
        name: "scenario",
        tooling: { build: { service: "appserver", cmd: "make" } },
      };
      const layer = makeLayer({ landofile, plan, provider });

      const result = await Effect.runPromise(runTooling({ name: "app:build" }).pipe(runtimeFor(layer)));

      expect(result.service).toBe("appserver");
      expect(result.stdout).toBe("from-provider");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toEqual(["sh", "-c", "make"]);
    });
  });

  test("rejects a .bun.sh that declares a non-:host service with NotImplementedError (Beta-deferred)", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "in-service.bun.sh",
        [
          "# ---",
          "# desc: Targets a container service",
          "# service: appserver",
          "# ---",
          "console.log('nope');",
          "",
        ].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider, calls } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = makeLayer({ landofile, plan, provider });

      const exit = await Effect.runPromiseExit(runTooling({ name: "in-service" }).pipe(runtimeFor(layer)));
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      const flat = JSON.stringify(exit.cause);
      expect(flat).toContain("NotImplementedError");
      expect(flat).toContain("Remove the `service:` field");
      expect(calls).toHaveLength(0);
    });
  });

  test("surfaces a malformed .bun.sh script as BunShellScriptFrontMatterError at invocation time", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(root, "broken.bun.sh", ["console.log('no front matter');", ""].join("\n"));

      const plan = makePlan([makeService("appserver", true)]);
      const { provider } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = makeLayer({ landofile, plan, provider });

      const exit = await Effect.runPromiseExit(runTooling({ name: "broken" }).pipe(runtimeFor(layer)));
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(JSON.stringify(exit.cause)).toContain("BunShellScriptFrontMatterError");
    });
  });

  test("falls through to ToolingCompileError when neither Landofile nor .bun.sh defines the task", async () => {
    await withAppRoot(async (root) => {
      await writeBunShScript(
        root,
        "build.bun.sh",
        ["# ---", "# desc: Real task", "# ---", "console.log('build');", ""].join("\n"),
      );

      const plan = makePlan([makeService("appserver", true)]);
      const { provider, calls } = makeProvider([]);
      const landofile: LandofileShape = { name: "scenario" };
      const layer = makeLayer({ landofile, plan, provider });

      const exit = await Effect.runPromiseExit(
        runTooling({ name: "does-not-exist" }).pipe(runtimeFor(layer)),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(JSON.stringify(exit.cause)).toContain("ToolingCompileError");
      expect(calls).toHaveLength(0);
    });
  });
});
