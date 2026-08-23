import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { CommandAliasConflictError, PluginLoadError } from "@lando/sdk/errors";
import {
  PluginManifest,
  PluginName,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  CommandRegistry,
  LandofileService,
  PluginRegistry,
  RuntimeProviderRegistry,
  type ServiceFeatureDefinition,
  type ServiceType,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { CacheServiceLive } from "../../src/testing/engine-layers.ts";
import { runTooling } from "../../src/testing/engine-layers.ts";
import { effectiveToolingForPlan } from "../../src/testing/engine-layers.ts";
import { PluginRegistryLive } from "../../src/testing/engine-layers.ts";
import { CommandRegistryLive } from "../../src/testing/engine-layers.ts";
import { EventServiceLive } from "../../src/testing/engine-layers.ts";
import { FileSystemLive } from "../../src/testing/engine-layers.ts";
import { AppPlannerLive } from "../../src/testing/engine-layers.ts";
import { emptyConfigServiceLayer } from "../cli/agent-env-test-config.ts";

const capabilities: ProviderCapabilities = {
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
  architectureEmulation: false,
  composeSpec: "native",
  providerExtensions: [],
};

test("attaches effective tooling on fresh and cache-hit plans and keys service tooling", async () => {
  // Given
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-effective-tooling-plan-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-effective-tooling-cache-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;

  let toolingCommand = "first";
  let featureCalls = 0;
  const feature: ServiceFeatureDefinition = {
    id: "effective-tooling-test-feature",
    priority: 1000,
    apply: () =>
      Effect.sync(() => {
        featureCalls += 1;
      }),
  };
  const serviceType: ServiceType = {
    id: "effective-tooling-test",
    name: "effective-tooling-test",
    base: "l337",
    schema: Schema.Unknown,
    resolve: (input) =>
      Effect.succeed({
        base: "l337" as const,
        normalizedConfig: input.service,
        features: [{ id: feature.id }],
        tooling: { inspect: { cmd: toolingCommand } },
      }),
  };
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: PluginName.make("@lando/effective-tooling-test"),
    version: "1.0.0",
    api: 4,
    contributes: { serviceTypes: [serviceType.id] },
  });
  const registryLayer = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (registry) => ({
      ...registry,
      list: Effect.succeed([manifest]),
      loadServiceType: (id: string) =>
        id === serviceType.id
          ? Effect.succeed(serviceType)
          : Effect.fail(new PluginLoadError({ message: `Unknown service type ${id}.`, pluginName: id })),
      loadServiceFeature: (id: string) =>
        id === feature.id ? Effect.succeed(feature) : registry.loadServiceFeature(id),
    })),
  ).pipe(Layer.provide(PluginRegistryLive));
  const plannerLayer = AppPlannerLive.pipe(
    Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, registryLayer)),
  );
  const landofile = {
    name: "effective-tooling-cache",
    services: { [ServiceName.make("web")]: { type: serviceType.id } },
  };

  try {
    await writeFile(
      join(appRoot, ".lando.yml"),
      "name: effective-tooling-cache\nservices:\n  web:\n    type: effective-tooling-test\n",
    );
    const runPlan = () =>
      Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
          Effect.provide(plannerLayer),
        ),
      );

    // When
    const fresh = await runPlan();
    const cacheHit = await runPlan();
    toolingCommand = "second";
    const changed = await runPlan();

    // Then
    expect(effectiveToolingForPlan(fresh)?.inspect).toEqual({ cmd: "first", service: "web" });
    expect(effectiveToolingForPlan(cacheHit)?.inspect).toEqual({ cmd: "first", service: "web" });
    expect(effectiveToolingForPlan(changed)?.inspect).toEqual({ cmd: "second", service: "web" });
    expect(featureCalls).toBe(2);

    let invocation: ToolingInvocation | undefined;
    const toolingLayer = Layer.mergeAll(
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(changed) }),
      Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
      Layer.succeed(ToolingEngine, {
        id: "recording",
        run: (nextInvocation) => {
          invocation = nextInvocation;
          return Effect.succeed({
            tool: nextInvocation.tool,
            service: ServiceName.make(nextInvocation.service ?? "web"),
            exitCode: 0,
            stdout: "",
            stderr: "",
          });
        },
      }),
      emptyConfigServiceLayer,
      EventServiceLive,
    );
    const registryIds = await Effect.runPromise(
      Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
        Effect.provide(Layer.provide(CommandRegistryLive, toolingLayer)),
      ),
    );
    expect(registryIds).toEqual([]);

    await Effect.runPromise(runTooling({ name: "inspect" }).pipe(Effect.provide(toolingLayer)));
    expect(invocation?.commands).toEqual([["sh", "-c", 'second "$@"', "lando-tooling"]]);
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

type PhpTooling = Readonly<Record<string, { readonly cmd: string }>>;

const phpServiceType = (tooling: PhpTooling): ServiceType => ({
  id: "php",
  name: "php",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: input.service,
      features: [],
      tooling,
    }),
});

const phpPlannerLayer = (serviceType: ServiceType) => {
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: PluginName.make("@lando/php"),
    version: "1.0.0",
    api: 4,
    contributes: { serviceTypes: [serviceType.id] },
  });
  const registryLayer = Layer.effect(
    PluginRegistry,
    Effect.map(PluginRegistry, (registry) => ({
      ...registry,
      list: Effect.succeed([manifest]),
      loadServiceType: (id: string) =>
        id === serviceType.id
          ? Effect.succeed(serviceType)
          : Effect.fail(new PluginLoadError({ message: `Unknown service type ${id}.`, pluginName: id })),
    })),
  ).pipe(Layer.provide(PluginRegistryLive));
  return AppPlannerLive.pipe(Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, registryLayer)));
};

const phpLandofile = (name: string, tooling?: PhpTooling) => ({
  name,
  services: { [ServiceName.make("web")]: { type: "php" } },
  ...(tooling === undefined ? {} : { tooling }),
});

const phpYaml = (name: string, toolingYaml = ""): string =>
  `name: ${name}\nservices:\n  web:\n    type: php\n${toolingYaml}`;

const withTempPlannerApp = async (yaml: string, run: () => Promise<void>): Promise<void> => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-reserved-tooling-plan-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-reserved-tooling-cache-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    await writeFile(join(appRoot, ".lando.yml"), yaml);
    await run();
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const planPhp = (landofile: ReturnType<typeof phpLandofile>, layer: ReturnType<typeof phpPlannerLayer>) =>
  Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(Effect.provide(layer));

const expectAliasConflict = (
  exit: Exit.Exit<unknown, unknown>,
  fields: { readonly alias: string; readonly claimedBy: string; readonly reservedFor: string },
): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") return;
  expect(failure.value).toBeInstanceOf(CommandAliasConflictError);
  if (!(failure.value instanceof CommandAliasConflictError)) return;
  expect(failure.value.alias).toBe(fields.alias);
  expect(failure.value.claimedBy).toBe(fields.claimedBy);
  expect(failure.value.reservedFor).toBe(fields.reservedFor);
};

test("plans successfully when php contributes unreserved inspect tooling", async () => {
  // Given
  const serviceType = phpServiceType({ inspect: { cmd: "php -v" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-inspect");

  await withTempPlannerApp(phpYaml("reserved-tooling-inspect"), async () => {
    // When
    const plan = await Effect.runPromise(planPhp(landofile, plannerLayer));

    // Then
    expect(effectiveToolingForPlan(plan)?.inspect).toEqual({ cmd: "php -v", service: "web" });
  });
});

test("fails plan with CommandAliasConflictError when php contributes reserved run tooling", async () => {
  // Given
  const serviceType = phpServiceType({ run: { cmd: "whoami" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-run");

  await withTempPlannerApp(phpYaml("reserved-tooling-run"), async () => {
    // When
    const exit = await Effect.runPromiseExit(planPhp(landofile, plannerLayer));

    // Then
    expectAliasConflict(exit, {
      alias: "run",
      claimedBy: "service type php task run",
      reservedFor: "apps:scratch:run",
    });
  });
});

test("fails plan on the first ordinal reserved survivor when php contributes scratch tooling", async () => {
  // Given
  const serviceType = phpServiceType({ scratch: { cmd: "a" }, "scratch:gc": { cmd: "b" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-scratch");

  await withTempPlannerApp(phpYaml("reserved-tooling-scratch"), async () => {
    // When
    const exit = await Effect.runPromiseExit(planPhp(landofile, plannerLayer));

    // Then
    expectAliasConflict(exit, {
      alias: "scratch",
      claimedBy: "service type php task scratch",
      reservedFor: "apps:scratch:start",
    });
  });
});

test("fails runTooling reserved when Landofile authors run even if php also contributes run", async () => {
  // Given
  const serviceType = phpServiceType({ run: { cmd: "whoami" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-authored-run", { run: { cmd: "authored" } });

  await withTempPlannerApp(
    phpYaml("reserved-tooling-authored-run", "tooling:\n  run:\n    cmd: authored\n"),
    async () => {
      const plan = await Effect.runPromise(planPhp(landofile, plannerLayer));
      const toolingLayer = Layer.mergeAll(
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
        }),
        Layer.succeed(ToolingEngine, {
          id: "noop",
          run: () =>
            Effect.succeed({
              tool: "run",
              service: ServiceName.make("web"),
              exitCode: 0,
              stdout: "",
              stderr: "",
            }),
        }),
        emptyConfigServiceLayer,
        EventServiceLive,
      );

      // When
      const exit = await Effect.runPromiseExit(
        runTooling({ name: "run" }).pipe(Effect.provide(toolingLayer)),
      );

      // Then
      expectAliasConflict(exit, {
        alias: "run",
        claimedBy: "tooling task run",
        reservedFor: "apps:scratch:run",
      });
    },
  );
});
