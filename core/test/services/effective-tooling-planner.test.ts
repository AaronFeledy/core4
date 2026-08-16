import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
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
