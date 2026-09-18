import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLandofileLayers } from "@lando/landofile/service";
import { makeLandoPaths } from "@lando/paths";
import { LandofileUnknownEventError, PluginLoadError } from "@lando/sdk/errors";
import {
  type LandofileShape,
  PluginManifest,
  PluginName,
  type ProviderCapabilities,
} from "@lando/sdk/schema";
import { AppPlanner, PathsService, PluginRegistry, type ServiceType, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { CacheServiceLive } from "../../src/cache/service.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { scopedLandofileRuntimeInputs } from "../../src/services/landofile-live.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

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

const LIFECYCLE_EVENTS = [
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
  "pre-destroy",
  "post-destroy",
];

/**
 * The one set every surface must report: the twelve lifecycle names plus both
 * brackets for each invocable task. `inspect` is contributed by the service
 * type, `docs:generate` by a public tooling include, `authored` by the
 * Landofile itself. `ops:migrate` comes from an `internal: true` include and
 * is therefore absent from both of its brackets.
 */
const EXPECTED_EVENTS = [
  ...LIFECYCLE_EVENTS,
  "post-authored",
  "post-docs:generate",
  "post-inspect",
  "pre-authored",
  "pre-docs:generate",
  "pre-inspect",
];

const serviceType: ServiceType = {
  id: "shared-event-resolution-type",
  name: "shared-event-resolution-type",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: input.service,
      features: [],
      tooling: { inspect: { cmd: "inspect" } },
    }),
};

const registryLayer = Layer.effect(
  PluginRegistry,
  Effect.map(PluginRegistry, (registry) => ({
    ...registry,
    list: Effect.succeed([
      Schema.decodeUnknownSync(PluginManifest)({
        name: PluginName.make("@lando/shared-event-resolution-test"),
        version: "1.0.0",
        api: 4,
        contributes: { serviceTypes: [serviceType.id] },
      }),
    ]),
    loadServiceType: (id: string) =>
      id === serviceType.id
        ? Effect.succeed(serviceType)
        : Effect.fail(new PluginLoadError({ message: `Unknown service type ${id}.`, pluginName: id })),
  })),
).pipe(Layer.provide(PluginRegistryLive));

const landofileYaml = `name: shared-event-resolution
runtime: 4
toolingIncludes:
  ops:
    file: ./ops/.lando.tasks.yml
    internal: true
  docs:
    file: ./docs/.lando.tasks.yml
services:
  web:
    type: ${serviceType.id}
    home: false
tooling:
  authored:
    service: ":host"
    cmd: echo authored
events:
  pre-typo:
    - cmd: echo typo
      service: ":host"
`;

const unknownEventFrom = (exit: Exit.Exit<unknown, unknown>): LandofileUnknownEventError => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected a typed failure");
  expect(failure.value).toBeInstanceOf(LandofileUnknownEventError);
  if (!(failure.value instanceof LandofileUnknownEventError)) throw new Error("expected unknown event");
  return failure.value;
};

const withApp = async (run: (appRoot: string) => Promise<void>): Promise<void> => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-shared-events-")));
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-shared-events-cache-")));
  const previousCwd = process.cwd();
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.chdir(appRoot);
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    await mkdir(join(appRoot, "ops"), { recursive: true });
    await mkdir(join(appRoot, "docs"), { recursive: true });
    await writeFile(join(appRoot, ".lando.yml"), landofileYaml);
    await writeFile(
      join(appRoot, "ops", ".lando.tasks.yml"),
      'tooling:\n  migrate:\n    service: ":host"\n    cmd: echo migrate\n',
    );
    await writeFile(
      join(appRoot, "docs", ".lando.tasks.yml"),
      'tooling:\n  generate:\n    service: ":host"\n    cmd: echo generate\n',
    );
    await run(appRoot);
  } finally {
    process.chdir(previousCwd);
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(appRoot, { recursive: true, force: true });
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const testServices = (appRoot: string) =>
  Layer.mergeAll(
    registryLayer,
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userConfRoot: join(appRoot, "conf"),
        userCacheRoot: process.env.LANDO_USER_CACHE_ROOT ?? join(appRoot, "cache"),
      }),
    ),
    Layer.succeed(
      StateStore,
      makeStateStore({
        privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      }),
    ),
  );

const loadLayered = (appRoot: string): Effect.Effect<LandofileShape, unknown, never> =>
  Effect.gen(function* () {
    const runtimeInputs = yield* scopedLandofileRuntimeInputs;
    return yield* loadLandofileLayers(appRoot, join(appRoot, ".lando.yml"), runtimeInputs);
  }).pipe(Effect.provide(testServices(appRoot))) as Effect.Effect<LandofileShape, unknown, never>;

test("lint and the planner report one identical known event set for the same app", async () => {
  await withApp(async (appRoot) => {
    // Given
    const plannerLayer = AppPlannerLive.pipe(
      Layer.provide(Layer.mergeAll(CacheServiceLive, FileSystemLive, registryLayer)),
    );

    // When
    const lintExit = await Effect.runPromiseExit(
      appConfigLint({ cwd: appRoot }).pipe(Effect.provide(testServices(appRoot))),
    );
    const landofile = await Effect.runPromise(loadLayered(appRoot));
    const planExit = await Effect.runPromiseExit(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
        Effect.provide(plannerLayer),
      ),
    );

    // Then
    const lintError = unknownEventFrom(lintExit);
    const planError = unknownEventFrom(planExit);
    expect(lintError.event).toBe("pre-typo");
    expect(planError.event).toBe("pre-typo");
    expect([...planError.validEvents]).toEqual(EXPECTED_EVENTS);
    expect([...lintError.validEvents]).toEqual(EXPECTED_EVENTS);
  });
});

test("lint accepts a service-contributed task bracket and rejects an internal include bracket", async () => {
  await withApp(async (appRoot) => {
    // Given
    const events = (body: string) => landofileYaml.replace(/events:\n[\s\S]*$/u, body);

    // When
    await writeFile(
      join(appRoot, ".lando.yml"),
      events('events:\n  pre-inspect:\n    - cmd: echo ok\n      service: ":host"\n'),
    );
    const accepted = await Effect.runPromise(
      appConfigLint({ cwd: appRoot }).pipe(Effect.provide(testServices(appRoot))),
    );
    await writeFile(
      join(appRoot, ".lando.yml"),
      events('events:\n  pre-ops:migrate:\n    - cmd: echo no\n      service: ":host"\n'),
    );
    const rejectedExit = await Effect.runPromiseExit(
      appConfigLint({ cwd: appRoot }).pipe(Effect.provide(testServices(appRoot))),
    );

    // Then
    expect(accepted.valid).toBe(true);
    expect(accepted.violations).toEqual([]);
    expect(unknownEventFrom(rejectedExit).event).toBe("pre-ops:migrate");
  });
});
