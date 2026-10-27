import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { CommandAliasConflictError, LandofileValidationError, PluginLoadError } from "@lando/sdk/errors";
import {
  type LandofileShape,
  PluginManifest,
  PluginName,
  PortNumber,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ToolingTaskShape,
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
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import * as AppCacheService from "../../src/cache/service.ts";
import { runTooling } from "../../src/operations/tooling.ts";
import { effectiveEventsForPlan } from "../../src/planner/effective-events.ts";
import { connectionClientsForPlan, effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as CommandRegistryLayer from "../../src/services/command-registry.ts";
import * as LandoEventService from "../../src/services/event-service.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { emptyConfigServiceLayer } from "../_support/agent-env-test-config.ts";

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
    toolingForConnection: () => ({ inspect: { cmd: toolingCommand } }),
    resolve: (input) =>
      Effect.succeed({
        base: "l337" as const,
        connection: {
          family: "postgres" as const,
          port: PortNumber.make(5432),
          creds: { user: "app", password: "descriptor", database: "app" },
        },
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
    Effect.map(PluginRegistry, (registry) =>
      PluginRegistry.of({
        ...registry,
        list: Effect.succeed([manifest]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({
                  message: `Unknown service type ${id}.`,
                  pluginName: id,
                  remediation: "Install or register the plugin, then retry.",
                }),
              ),
        loadServiceFeature: (id: string) =>
          id === feature.id ? Effect.succeed(feature) : registry.loadServiceFeature(id),
      }),
    ),
  ).pipe(Layer.provide(PluginRegistryLayer.layer));
  const plannerLayer = AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(AppCacheService.layer, BunFileSystem.layer, registryLayer)),
  );
  const landofile = {
    name: "effective-tooling-cache",
    services: { [ServiceName.make("web")]: { type: serviceType.id, home: false as const } },
    events: { "pre-start": ["echo event"] },
  };

  try {
    await writeFile(
      join(appRoot, ".lando.yml"),
      "name: effective-tooling-cache\nservices:\n  web:\n    type: effective-tooling-test\n    home: false\nevents:\n  pre-start:\n    - echo event\n",
    );
    const runPlan = () =>
      Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) => planTestLandofile(planner, landofile, capabilities)).pipe(
          Effect.provide(plannerLayer),
        ),
      );

    // When
    const fresh = await runPlan();
    const cacheHit = await runPlan();
    expect(connectionClientsForPlan(fresh)).toEqual({ inspect: ServiceName.make("web") });
    expect(connectionClientsForPlan(cacheHit)).toEqual({ inspect: ServiceName.make("web") });
    toolingCommand = "second";
    const changed = await runPlan();

    // Then
    expect(effectiveToolingForPlan(fresh)?.inspect).toEqual({ cmd: "first", service: "web" });
    expect(effectiveToolingForPlan(cacheHit)?.inspect).toEqual({ cmd: "first", service: "web" });
    expect(effectiveToolingForPlan(changed)?.inspect).toEqual({ cmd: "second", service: "web" });
    expect(effectiveEventsForPlan(fresh)?.["pre-start"]).toEqual(["echo event"]);
    expect(effectiveEventsForPlan(cacheHit)?.["pre-start"]).toEqual(["echo event"]);
    expect(effectiveEventsForPlan(changed)?.["pre-start"]).toEqual(["echo event"]);
    expect(featureCalls).toBe(2);

    let invocation: ToolingInvocation | undefined;
    const toolingLayer = Layer.mergeAll(
      registryLayer,
      testEnvironmentResolverLayer,
      Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(changed) })),
      Layer.succeed(LandofileService, LandofileService.of({ discover: compileTestLandofile(landofile) })),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          appliedPlansFor: () => Effect.succeed([changed]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
        }),
      ),
      Layer.succeed(
        ToolingEngine,
        ToolingEngine.of({
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
      ),
      emptyConfigServiceLayer,
      LandoEventService.layer,
      PrivateFileAccessService.layer,
    );
    const registryIds = await Effect.runPromise(
      Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
        Effect.provide(Layer.provide(CommandRegistryLayer.layer, toolingLayer)),
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

type PhpTooling = Readonly<Record<string, ToolingTaskShape>>;

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
    Effect.map(PluginRegistry, (registry) =>
      PluginRegistry.of({
        ...registry,
        list: Effect.succeed([manifest]),
        loadServiceType: (id: string) =>
          id === serviceType.id
            ? Effect.succeed(serviceType)
            : Effect.fail(
                new PluginLoadError({
                  message: `Unknown service type ${id}.`,
                  pluginName: id,
                  remediation: "Install or register the plugin, then retry.",
                }),
              ),
      }),
    ),
  ).pipe(Layer.provide(PluginRegistryLayer.layer));
  return AppPlannerLayer.layer.pipe(
    Layer.provide(Layer.mergeAll(AppCacheService.layer, BunFileSystem.layer, registryLayer)),
  );
};

const phpLandofile = (name: string, tooling?: PhpTooling) => ({
  name,
  services: { [ServiceName.make("web")]: { type: "php", home: false as const } },
  ...(tooling === undefined ? {} : { tooling }),
});

const phpYaml = (name: string, toolingYaml = ""): string =>
  `name: ${name}\nservices:\n  web:\n    type: php\n    home: false\n${toolingYaml}`;

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

const planPhp = (landofile: LandofileShape, layer: ReturnType<typeof phpPlannerLayer>) =>
  Effect.flatMap(AppPlanner, (planner) => planTestLandofile(planner, landofile, capabilities)).pipe(
    Effect.provide(layer),
  );

const expectAliasConflict = (
  exit: Exit.Exit<unknown, unknown>,
  fields: { readonly alias: string; readonly claimedBy: string; readonly reservedFor: string },
): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") return;
  expect(failure.value).toBeInstanceOf(CommandAliasConflictError);
  if (!(failure.value instanceof CommandAliasConflictError)) return;
  expect(failure.value.alias).toBe(fields.alias);
  expect(failure.value.claimedBy).toBe(fields.claimedBy);
  expect(failure.value.reservedFor).toBe(fields.reservedFor);
};

const expectToolingIssues = (exit: Exit.Exit<unknown, unknown>, names: ReadonlyArray<string>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected planning failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some" || !(failure.value instanceof LandofileValidationError)) {
    throw new Error("expected LandofileValidationError");
  }
  expect(failure.value.issues.map(({ rule, path }) => ({ rule, path }))).toEqual(
    names.map((name) => ({ rule: "landofile.tooling", path: ["tooling", name] })),
  );
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

test("fails plan with landofile.tooling when php contributes reserved run tooling", async () => {
  // Given
  const serviceType = phpServiceType({ run: { cmd: "whoami" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-run");

  await withTempPlannerApp(phpYaml("reserved-tooling-run"), async () => {
    // When
    const exit = await Effect.runPromiseExit(planPhp(landofile, plannerLayer));

    // Then
    expectToolingIssues(exit, ["run"]);
  });
});

test("reports every reserved survivor when php contributes scratch tooling", async () => {
  // Given
  const serviceType = phpServiceType({ scratch: { cmd: "a" }, "scratch:gc": { cmd: "b" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-scratch");

  await withTempPlannerApp(phpYaml("reserved-tooling-scratch"), async () => {
    // When
    const exit = await Effect.runPromiseExit(planPhp(landofile, plannerLayer));

    // Then
    expectToolingIssues(exit, ["scratch", "scratch:gc"]);
  });
});

test("fails runTooling reserved when a stale plan predates authored run", async () => {
  // Given
  const serviceType = phpServiceType({ inspect: { cmd: "whoami" } });
  const plannerLayer = phpPlannerLayer(serviceType);
  const landofile = phpLandofile("reserved-tooling-authored-run", { run: { cmd: "authored" } });

  await withTempPlannerApp(
    phpYaml("reserved-tooling-authored-run", "tooling:\n  run:\n    cmd: authored\n"),
    async () => {
      const plan = await Effect.runPromise(
        planPhp(phpLandofile("reserved-tooling-authored-run"), plannerLayer),
      );
      const toolingLayer = Layer.mergeAll(
        testEnvironmentResolverLayer,
        Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
        Layer.succeed(LandofileService, LandofileService.of({ discover: compileTestLandofile(landofile) })),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            appliedPlansFor: () => Effect.succeed([]),
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
            capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
            select: () => Effect.succeed(TestRuntimeProvider),
          }),
        ),
        Layer.succeed(
          ToolingEngine,
          ToolingEngine.of({
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
        ),
        emptyConfigServiceLayer,
        LandoEventService.layer,
        PrivateFileAccessService.layer,
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

test("rejects authored run during planning even when it overlays service-type run", async () => {
  // Given
  const layer = phpPlannerLayer(phpServiceType({ run: { cmd: "service" } }));
  const landofile = phpLandofile("authored-reserved-run", { run: { cmd: "authored" } });
  await withTempPlannerApp(phpYaml(landofile.name), async () => {
    // When
    const exit = await Effect.runPromiseExit(planPhp(landofile, layer));
    // Then
    expectToolingIssues(exit, ["run"]);
  });
});

test("plans when a disabled authored overlay drops service-type run", async () => {
  // Given
  const layer = phpPlannerLayer(phpServiceType({ run: { cmd: "service" } }));
  const landofile = phpLandofile("disabled-reserved-run", { run: { disabled: true } });
  await withTempPlannerApp(phpYaml(landofile.name), async () => {
    // When
    const plan = await Effect.runPromise(planPhp(landofile, layer));
    // Then
    expect(effectiveToolingForPlan(plan)?.run?.disabled).toBe(true);
  });
});

test("plans when the first service contributor disables a reserved name claimed by a later service", async () => {
  // Given
  const serviceType: ServiceType = {
    ...phpServiceType({}),
    resolve: (input) =>
      Effect.succeed({
        base: "l337" as const,
        normalizedConfig: input.service,
        features: [],
        tooling: { run: { cmd: "service", disabled: input.name === "a" } },
      }),
  };
  const layer = phpPlannerLayer(serviceType);
  const landofile: LandofileShape = {
    name: "disabled-first-contributor",
    services: {
      [ServiceName.make("b")]: { type: "php", home: false },
      [ServiceName.make("a")]: { type: "php", home: false },
    },
  };
  await withTempPlannerApp(phpYaml("disabled-first-contributor"), async () => {
    // When
    const plan = await Effect.runPromise(planPhp(landofile, layer));
    // Then
    expect(effectiveToolingForPlan(plan)?.run).toMatchObject({ service: "a", disabled: true });
  });
});
import { compileTestLandofile, planTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
