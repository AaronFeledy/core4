import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";

import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, DateTime, Effect, Exit, Layer, Schema, Stream } from "effect";

import { destroyApp, renderDestroyAppResult } from "@lando/core/cli/operations";
import { EventError, FileSyncStopError, ProviderUnavailableError, ProxyError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  EventService,
  FileSyncEngine,
  LandofileService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import { makeTestStateStore } from "@lando/core/testing";
import * as BunDataMover from "@lando/data-mover/service";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { type RendererIO, createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope, SnapshotInfo, appIdentityKey } from "@lando/sdk/schema";
import { DataMover, RuntimeProvider, StateStore } from "@lando/sdk/services";
import type {
  AppSelector,
  AppliedFileSyncInspection,
  DestroyOptions,
  FileSyncEngineShape,
  RuntimeProviderShape,
} from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import * as DiskStateStore from "@lando/state-store/service";
import { destroySpec, runDestroyCommand } from "../../src/cli/command-specs/app/destroy.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";
import { clearActiveCommandInvocation, commandErrorMessage } from "../../src/cli/compiled-session.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { withCwd } from "../_support/temp-cwd.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");

const ownerKey = (root: string): string => appIdentityKey("owner", root);

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
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
  architectureEmulation: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "destroy.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "web" ? ["node", "server.js"] : ["postgres"],
  environment: {},
  mounts:
    name === "database"
      ? [
          {
            type: "volume",
            store: "test_destroy_database_data",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
  endpoints:
    name === "web"
      ? [{ _tag: "published", port: 3000, protocol: "http", name: "http", publication: { hostPort: 3000 } }]
      : [{ _tag: "internal", port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn:
    name === "web"
      ? [{ service: ServiceName.make("database"), condition: "service_started", required: true }]
      : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const database = servicePlan("database");
const testAppRoot = mkdtempSync(join(tmpdir(), "lando-destroy-app-root-"));
afterAll(() => rmSync(testAppRoot, { recursive: true, force: true }));

const plan: AppPlan = {
  id: AppId.make("test-destroy"),
  name: "test-destroy",
  slug: "test-destroy",
  root: AbsolutePath.make(testAppRoot),
  identity: { appRoot: AbsolutePath.make(testAppRoot), ownerKey: ownerKey(testAppRoot) },
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [],
  stores: [
    { name: "test_destroy_database_data", scope: "app", kind: "data" },
    { name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" },
  ],
  fileSync: [],
  metadata,
  extensions: {},
};

const testSessionSpec = (mountKey: string) => ({
  app: { kind: "user" as const, id: plan.id, root: plan.root },
  service: web.name,
  mountKey,
  source: plan.root,
  target: { _tag: "volume" as const, name: `${plan.name}-web-${mountKey}`, path: PortablePath.make("/app") },
  mode: "two-way-safe" as const,
  excludes: [],
});

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-destroy-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const makeDestroyLayer = (
  options: {
    readonly userDataRoot?: string;
    readonly providerDestroyEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly quiesceEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly proxyRemoveEffect?: Effect.Effect<void, ProxyError>;
    readonly proxyAvailable?: boolean;
    readonly plannedApp?: AppPlan;
    readonly appliedPlanEvidence?: boolean;
    readonly appliedFileSync?: AppliedFileSyncInspection;
    readonly removeSnapshotEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly absent?: boolean;
    readonly orphanEvidence?: boolean;
    readonly ownedEvidence?: boolean;
    readonly preDestroyFailure?: EventError;
    readonly leftoverOrphans?: boolean;
    readonly appliedInventory?: boolean;
  } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const appliedFileSync = options.appliedFileSync;
  const stateStore = makeTestStateStore();
  const removedSnapshots: string[] = [];

  const events: string[] = [];
  const publishedEvents: Array<{ readonly _tag: string; readonly [key: string]: unknown }> = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const evidenceRoots: string[] = [];
  const volumes = new Set(plannedApp.stores.map((store) => store.name));
  const routeRemovals: string[] = [];
  const mutations: string[] = [];
  const orphanGroup = {
    providerId,
    appId: plannedApp.id,
    volumes: [],
    services: [
      {
        app: plannedApp.id,
        appRoot: plannedApp.root,
        providerId,
        service: ServiceName.make("orphan"),
        status: "stopped" as const,
        containerId: "orphan-container",
        publications: { status: "unknown" as const },
      },
    ],
  };
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    ...(options.orphanEvidence === true || options.leftoverOrphans === true
      ? {
          removeObservedService: () =>
            Effect.sync(() => {
              mutations.push("remove:orphan");
              return { kind: "removed" as const };
            }),
        }
      : {}),
    removeVolumeSnapshot: (snapshot) =>
      (options.removeSnapshotEffect ?? Effect.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            removedSnapshots.push(snapshot.id);
          }),
        ),
      ),
    ...(appliedFileSync === undefined
      ? {}
      : { inspectAppliedFileSync: () => Effect.succeed(appliedFileSync) }),
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "buildArtifact",
          message: "unavailable",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    ...(options.quiesceEffect === undefined
      ? {}
      : { quiesceForFileSync: () => options.quiesceEffect ?? Effect.void }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => {
        destroyCalls.push({ target, options: destroyOptions });
        if (destroyOptions.volumes || destroyOptions.purgeCaches) {
          for (const store of plannedApp.stores) {
            if (store.kind === "cache") {
              if (destroyOptions.purgeCaches) volumes.delete(store.name);
            } else if (destroyOptions.volumes && store.scope !== "global") {
              volumes.delete(store.name);
            }
          }
        }
      }).pipe(
        Effect.andThen(options.providerDestroyEffect ?? Effect.void),
        Effect.as({ kind: "destroyed" as const }),
      ),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: () =>
      Effect.succeed({
        app: plannedApp.id,
        service: ServiceName.make("web"),
        providerId,
        status: "stopped",
        state: "stopped",
        publications: { status: "present", bindings: [] },
      }),
    list: () => Effect.succeed([]),
    cleanupOwnedResources: () =>
      Effect.sync(() => {
        mutations.push("inventory");
        return { servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 };
      }),
  };

  const proxyLayer = Layer.succeed(
    RouterService,
    RouterService.of({
      id: "recording",
      capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
      setup: () => Effect.void,
      revalidateStartup: Effect.void,
      observeRoutes: () => Effect.succeed({ configuredAuthorities: [], observation: { status: "unknown" } }),
      applyRoutes: (routes, app) => Effect.succeed({ app, appliedRoutes: routes, authorities: [] }),
      removeRoutes: (app) =>
        Effect.sync(() => void routeRemovals.push(String(app))).pipe(
          Effect.andThen(options.proxyRemoveEffect ?? Effect.void),
        ),
      status: Effect.succeed({ state: "running" as const, authorities: [], configuredApps: [] }),
      stop: Effect.void,
    }),
  );
  const baseCommandLayer = Layer.mergeAll(
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    stateStore.layer,
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(literalLandofile({ name: "test-destroy", services: {} }, testAppRoot)),
      }),
    ),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: options.userDataRoot ?? join(testAppRoot, "lando-data"),
        userCacheRoot: join(testAppRoot, "lando-cache"),
        userConfRoot: join(testAppRoot, "lando-conf"),
        systemPluginRoot: join(testAppRoot, "lando-plugins"),
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(plannedApp)) })),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveTeardownEvidence: () =>
          Effect.succeed(
            options.absent !== true
              ? { kind: "applied" as const, plan: plannedApp }
              : { kind: "absent" as const },
          ),
        appliedPlansFor: () => Effect.succeed([]),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
        resolveAppliedPlan: () => Effect.succeed(options.absent === true ? undefined : plannedApp),
        ...(options.ownedEvidence === true
          ? {
              resolveTeardownEvidence: () =>
                Effect.succeed({
                  kind: "owned" as const,
                  ownership: [
                    {
                      providerId,
                      ownerKey: ownerKey(plannedApp.root),
                      appRoot: plannedApp.root,
                      appIds: [plannedApp.id],
                    },
                  ],
                }),
            }
          : {}),
        ...(options.orphanEvidence === true
          ? {
              resolveTeardownEvidence: () =>
                Effect.succeed({
                  kind: "orphans" as const,
                  groups: [
                    {
                      providerId,
                      appId: plannedApp.id,
                      volumes: [],
                      services: [
                        {
                          app: plannedApp.id,
                          appRoot: plannedApp.root,
                          providerId,
                          service: ServiceName.make("orphan"),
                          status: "stopped" as const,
                          containerId: "orphan-container",
                          publications: { status: "unknown" as const },
                        },
                      ],
                    },
                  ],
                }),
            }
          : {}),
        ...(options.appliedPlanEvidence === true
          ? {
              resolveTeardownEvidence: (root: AbsolutePath) => {
                evidenceRoots.push(root);
                return Effect.succeed(
                  destroyCalls.length === 0
                    ? {
                        kind: "applied" as const,
                        plan: plannedApp,
                        ownership:
                          options.appliedInventory === true
                            ? [
                                {
                                  providerId,
                                  ownerKey: ownerKey(plannedApp.root),
                                  appRoot: plannedApp.root,
                                  appIds: [plannedApp.id],
                                },
                              ]
                            : [],
                      }
                    : options.leftoverOrphans === true
                      ? { kind: "orphans" as const, groups: [orphanGroup] }
                      : { kind: "absent" as const },
                );
              },
            }
          : {}),
      }),
    ),
    ...(options.proxyAvailable === false ? [] : [proxyLayer]),
  );
  const eventLayer = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          events.push(event._tag);
          mutations.push(event._tag);
          publishedEvents.push(event);
        }).pipe(
          Effect.andThen(
            event._tag === "pre-destroy" && options.preDestroyFailure !== undefined
              ? Effect.fail(options.preDestroyFailure)
              : Effect.void,
          ),
        ),
      subscribe: () => Stream.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );
  const moverLayer = BunDataMover.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        baseCommandLayer,
        eventLayer,
        Layer.succeed(RedactionService, makeRedactionService()),
        Layer.succeed(RuntimeProvider, provider),
        DiskStateStore.layer,
      ),
    ),
  );
  const commandLayer = Layer.merge(baseCommandLayer, moverLayer);
  const layer = Layer.merge(commandLayer, eventLayer);

  return {
    layer,
    commandLayer,
    events,
    publishedEvents,
    destroyCalls,
    routeRemovals,
    volumes,
    evidenceRoots,
    stateStore: stateStore.service,
    removedSnapshots,
    mutations,
  };
};

const runDestroyCli = (
  argv: ReadonlyArray<string>,
  harness: ReturnType<typeof makeDestroyLayer>,
  io: RendererIO,
  mode: "plain" | "json",
) => {
  const input = compiledCommandInputFromArgv("app:destroy", argv);
  return runWithRendererHandling(destroySpec.run(input), {
    // Match native dispatch: LandoCommandSpec erases the command's service requirement to unknown.
    runtime: harness.commandLayer as Layer.Layer<unknown>,
    rendererMode: mode,
    resultFormat: mode === "json" ? "json" : "text",
    command: "app:destroy",
    resultSchema: destroySpec.resultSchema,
    render: (result, context) => destroySpec.render?.(result, input, context),
    io,
    formatError: (failure) => commandErrorMessage(failure, "app:destroy"),
  }).finally(clearActiveCommandInvocation);
};

const seedSnapshot = async (
  _harness: ReturnType<typeof makeDestroyLayer>,
  dataRoot: string,
  input: { readonly id: string; readonly sourceRoot?: string; readonly appId?: string },
) => {
  const info = Schema.decodeUnknownSync(SnapshotInfo)({
    owner: { appRoot: input.sourceRoot ?? "/unknown", ownerKey: ownerKey(input.sourceRoot ?? "/unknown") },
    id: input.id,
    store: { app: input.appId ?? plan.id, store: "data" },
    digest: "sha256:snapshot",
    sizeBytes: 42,
    createdAt: "2026-05-15T00:00:00Z",
    native: { provider: "docker", id: input.id, digest: "sha256:snapshot", sizeBytes: 42, format: "native" },
    ...(input.sourceRoot === undefined
      ? {}
      : {
          metadata: {
            service: "database",
            volumeInstanceId: "volume-instance",
            family: "postgres",
            version: "16",
            imageIdentity: "sha256:postgres",
            recoveryReason: "manual",
          },
        }),
  });
  const appDir = makeLandoPaths({ userDataRoot: dataRoot, platform: "linux" }).ownerSnapshotsDir(
    info.owner.ownerKey,
  );
  await mkdir(join(appDir, "data"), { recursive: true });
  const sidecar = join(appDir, "data", `${info.id}.json`);
  await Effect.runPromise(
    Effect.gen(function* () {
      const stateStore = yield* StateStore;
      const bucket = yield* stateStore.open({
        root: { path: AbsolutePath.make(join(appDir, "data")) },
        key: `${info.id}.json`,
        schema: SnapshotInfo,
        version: 1,
        codec: "json",
        lock: "advisory",
        onCorrupt: "fail",
      });
      yield* bucket.set(info);
    }).pipe(Effect.provide(DiskStateStore.layer)),
  );
  return { info, sidecar };
};

const DESTROY_LIFECYCLE_TAGS = ["pre-init", "post-init", "pre-destroy", "post-destroy"] as const;

const expectDestroyLifecycleWithTasks = (events: ReadonlyArray<string>): void => {
  expect(events.filter((tag) => (DESTROY_LIFECYCLE_TAGS as ReadonlyArray<string>).includes(tag))).toEqual([
    ...DESTROY_LIFECYCLE_TAGS,
  ]);
  const pre = events.indexOf("pre-destroy");
  const post = events.indexOf("post-destroy");
  expect(pre).toBeGreaterThan(-1);
  expect(post).toBeGreaterThan(pre);
  const between = events.slice(pre + 1, post);
  expect(between).toContain("task.tree.start");
  expect(between).toContain("task.tree.complete");
};

const expectMissingPath = async (path: string): Promise<void> => {
  try {
    await stat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
  throw new Error(`Expected ${path} to be removed.`);
};

const expectRecordedBracket = (
  harness: ReturnType<typeof makeDestroyLayer>,
  evidence: "applied" | "orphans" | "inventory" | "snapshots",
  expected: {
    readonly outcome: "destroyed" | "unchanged";
    readonly children: ReadonlyArray<string>;
    readonly ids?: ReadonlyArray<string>;
  },
) => {
  const ids = expected.ids ?? [plan.id];
  expect(harness.publishedEvents.filter((event) => event._tag === "pre-destroy")).toMatchObject(
    ids.map((id) => ({ app: { id }, evidence })),
  );
  expect(harness.publishedEvents.filter((event) => event._tag === "post-destroy")).toMatchObject(
    ids.map((id) => ({ app: { id }, evidence, outcome: expected.outcome })),
  );
  expect(harness.publishedEvents.filter((event) => event._tag === "task.tree.start")).toMatchObject([
    { children: expected.children.map((id) => startChildTaskId(`destroy-${ids[0]}`, id)) },
  ]);
  expect(harness.events.indexOf("pre-destroy")).toBeLessThan(harness.events.indexOf("task.tree.start"));
  expect(harness.events.indexOf("task.tree.complete")).toBeLessThan(harness.events.indexOf("post-destroy"));
  expect(harness.events.at(-1)).toBe("post-destroy");
  if (evidence !== "applied") {
    expect(harness.events).not.toContain("pre-init");
    expect(harness.events).not.toContain("post-init");
  }
};

describe("lando destroy", () => {
  test("inventory evidence brackets an unchanged cleanup when recorded resources are absent", async () => {
    const harness = makeDestroyLayer({ ownedEvidence: true });
    const result = await withCwd(testAppRoot, () =>
      Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer))),
    );
    expect(result).toMatchObject({ outcome: "unchanged", servicesDestroyed: [], snapshotsRemoved: 0 });
    expectRecordedBracket(harness, "inventory", { outcome: "unchanged", children: ["provider"] });
    expect(harness.destroyCalls).toEqual([]);
    expect(harness.mutations.indexOf("inventory")).toBeLessThan(harness.mutations.indexOf("post-destroy"));
  });

  test.each([false, true])(
    "known-empty teardown publishes no bracket or tree (purge=%s)",
    async (purgeSnapshots) => {
      const harness = makeDestroyLayer({ absent: true });
      const result = await withCwd(testAppRoot, () =>
        Effect.runPromise(destroyApp({ purgeSnapshots }).pipe(Effect.provide(harness.layer))),
      );
      expect(result).toMatchObject({ outcome: "unchanged", servicesDestroyed: [], snapshotsRemoved: 0 });
      expect(harness.events).toEqual([]);
      expect(harness.destroyCalls).toEqual([]);
    },
  );

  test.each([false, true])(
    "snapshot-only purge uses every recorded app id with deleted Landofile=%s",
    async (deleted) => {
      await withTempCwd(async (dataRoot) => {
        const root = join(dataRoot, "app");
        await mkdir(root);
        await Bun.write(join(root, ".lando.yml"), "name: edited-name\n");
        if (deleted) await rm(join(root, ".lando.yml"));
        const harness = makeDestroyLayer({ userDataRoot: dataRoot, absent: true });
        const a = await seedSnapshot(harness, dataRoot, { id: "a", sourceRoot: root, appId: "old-name" });
        const b = await seedSnapshot(harness, dataRoot, {
          id: "b",
          sourceRoot: root,
          appId: "recorded-name",
        });
        const result = await withCwd(root, () =>
          Effect.runPromise(
            runDestroyCommand({ flags: { purge: true, yes: true } }).pipe(Effect.provide(harness.layer)),
          ),
        );
        expect(result).toMatchObject({ outcome: "destroyed", snapshotsRemoved: 2, servicesDestroyed: [] });
        expectRecordedBracket(harness, "snapshots", {
          outcome: "destroyed",
          children: ["snapshots"],
          ids: ["old-name", "recorded-name"],
        });
        expect(harness.removedSnapshots).toEqual([a.info.id, b.info.id]);
        await expectMissingPath(
          makeLandoPaths({ userDataRoot: dataRoot, platform: "linux" }).ownerSnapshotsDir(ownerKey(root)),
        );
      });
    },
  );

  test.each(["applied", "orphans", "inventory", "snapshots"] as const)(
    "a pre-destroy subscriber vetoes %s removal",
    async (evidence) => {
      await withTempCwd(async (dataRoot) => {
        const harness = makeDestroyLayer({
          userDataRoot: dataRoot,
          absent: evidence === "snapshots",
          orphanEvidence: evidence === "orphans",
          ownedEvidence: evidence === "inventory",
          preDestroyFailure: new EventError({ message: "veto", event: "pre-destroy" }),
        });
        const owned = await seedSnapshot(harness, dataRoot, { id: "vetoed", sourceRoot: testAppRoot });
        const result = await withCwd(testAppRoot, () =>
          Effect.runPromiseExit(
            destroyApp({ purgeSnapshots: true, volumes: true }).pipe(Effect.provide(harness.layer)),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(harness.publishedEvents.find((event) => event._tag === "pre-destroy")).toMatchObject({
          evidence,
        });
        expect(harness.events).not.toContain("post-destroy");
        expect(harness.events).not.toContain("task.tree.start");
        expect(harness.destroyCalls).toEqual([]);
        expect(harness.removedSnapshots).toEqual([]);
        expect(harness.mutations).not.toContain("remove:orphan");
        expect(harness.mutations).not.toContain("inventory");
        expect(await Bun.file(owned.sidecar).exists()).toBe(true);
      });
    },
  );

  test("missing-root applied teardown sweeps leftover orphans within one bracket", async () => {
    await withTempCwd(async (dataRoot) => {
      const root = AbsolutePath.make(join(dataRoot, "gone"));
      const appliedPlan = { ...plan, root, identity: { appRoot: root, ownerKey: ownerKey(root) } };
      const harness = makeDestroyLayer({
        userDataRoot: dataRoot,
        plannedApp: appliedPlan,
        appliedPlanEvidence: true,
        leftoverOrphans: true,
      });
      const result = await Effect.runPromise(
        runDestroyCommand({ flags: { root, yes: true } }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.servicesDestroyed).toEqual(["database", "web", "orphan"]);
      expectRecordedBracket(harness, "applied", {
        outcome: "destroyed",
        children: ["provider", "host-proxy", "routes"],
      });
      expect(harness.destroyCalls).toHaveLength(1);
      expect(harness.mutations.indexOf("remove:orphan")).toBeGreaterThan(
        harness.mutations.indexOf("pre-destroy"),
      );
      expect(harness.mutations.indexOf("remove:orphan")).toBeLessThan(
        harness.mutations.indexOf("post-destroy"),
      );
    });
  });

  test("relative --root resolves against cwd and destroys the recorded missing app", async () => {
    await withTempCwd(async (parent) => {
      const root = AbsolutePath.make(join(parent, "gone"));
      const appliedPlan = { ...plan, root, identity: { appRoot: root, ownerKey: ownerKey(root) } };
      const harness = makeDestroyLayer({ plannedApp: appliedPlan, appliedPlanEvidence: true });
      const io = createBufferedRendererIO();
      await withCwd(parent, () => runDestroyCli(["--root", "gone", "--yes"], harness, io, "plain"));
      expect(harness.evidenceRoots.length).toBeGreaterThan(0);
      expect(harness.evidenceRoots.every((candidate) => candidate === root)).toBe(true);
      expect(harness.destroyCalls).toHaveLength(1);
      expect(harness.destroyCalls[0]?.target.plan).toEqual(appliedPlan);
    });
  });

  test("renders the proxy-unavailable warning through the production destroy command boundary", async () => {
    // Given
    const harness = makeDestroyLayer({ proxyAvailable: false });
    const io = createBufferedRendererIO();

    // When
    await runDestroyCli(["-y"], harness, io, "plain");

    // Then
    expect(io.stderr()).toContain(
      "Proxy service is unavailable; destroying test-destroy without route cleanup.",
    );
    expect(io.stdout()).not.toContain("Proxy service is unavailable");
  });

  test("paints a real destroy task tree through the native destroy spec in plain mode", async () => {
    // Given: production CLI destroy with a buffered plain renderer.
    const harness = makeDestroyLayer();
    const io = createBufferedRendererIO();

    // When
    await runDestroyCli(["-y"], harness, io, "plain");

    // Then: stderr paints the producer tree and stdout contains only the final result.
    expect(io.stderr()).toContain("Destroy test-destroy");
    expect(io.stderr()).toContain("Destroy services");
    expect(io.stdout()).toBe(
      `${renderDestroyAppResult({
        app: "test-destroy",
        servicesDestroyed: ["database", "web"],
        volumesRemoved: false,
        snapshotsRemoved: 0,
      })}\n`,
    );
  });

  test("json destroy emits one envelope and no live task paint", async () => {
    // Given: production CLI destroy under JSON machine output.
    const harness = makeDestroyLayer();
    const io = createBufferedRendererIO();

    // When
    await runDestroyCli(["--yes"], harness, io, "json");

    // Then: one envelope, no task paint on stderr.
    const stdoutLines = io.stdoutLines();
    expect(stdoutLines).toHaveLength(1);
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdoutLines[0] ?? "{}"))).toMatchObject(
      {
        apiVersion: "v4",
        command: "app:destroy",
        ok: true,
        result: {
          app: "test-destroy",
          servicesDestroyed: ["database", "web"],
          volumesRemoved: false,
        },
      },
    );
    expect(io.stderr()).not.toContain("task.tree.start");
    expect(io.stderr()).not.toContain("task.start");
    expect(io.stderr()).not.toContain("▼");
  });

  test("--root surfaces a tagged refusal for an existing folder without provider mutation", async () => {
    await withTempCwd(async (root) => {
      const harness = makeDestroyLayer();
      const result = await Effect.runPromise(
        runDestroyCommand({ flags: { root, yes: true } }).pipe(Effect.provide(harness.layer), Effect.result),
      );
      if (result._tag !== "Failure") throw new TypeError("expected existing-root refusal");
      expect(result.failure).toMatchObject({
        _tag: "AppResolveError",
        reason: "mismatch",
        detail: "root-exists",
      });
      expect(harness.destroyCalls).toEqual([]);
    });
  });

  test("destroys the provider when no proxy service can be resolved", async () => {
    const harness = makeDestroyLayer({ proxyAvailable: false });

    await Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.routeRemovals).toEqual([]);
    expect(harness.publishedEvents).toContainEqual(
      expect.objectContaining({
        _tag: "message.warn",
        body: "Proxy service is unavailable; destroying test-destroy without route cleanup.",
      }),
    );
  });

  test("removes routes when provider destroy fails and reports both failures", async () => {
    // Given
    const providerFailure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "destroy",
      message: "provider destroy failed",
    });
    const proxyFailure = new ProxyError({ message: "route removal failed", proxyId: "recording" });
    const harness = makeDestroyLayer({
      providerDestroyEffect: Effect.fail(providerFailure),
      proxyRemoveEffect: Effect.fail(proxyFailure),
    });

    // When
    const exit = await Effect.runPromiseExit(destroyApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(harness.routeRemovals).toEqual([String(plan.id)]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected failure");
    expect(Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))).toEqual(
      expect.arrayContaining([providerFailure, proxyFailure]),
    );
  });

  test("destroys the provider when route removal fails", async () => {
    // Given
    const proxyFailure = new ProxyError({ message: "route removal failed", proxyId: "recording" });
    const harness = makeDestroyLayer({ proxyRemoveEffect: Effect.fail(proxyFailure) });

    // When
    await Effect.runPromiseExit(destroyApp().pipe(Effect.provide(harness.layer)));

    // Then
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.routeRemovals).toEqual([String(plan.id)]);
  });
  test("destroys the recorded app and finishes inventory cleanup before the applied post event", async () => {
    const harness = makeDestroyLayer({ appliedPlanEvidence: true, appliedInventory: true });
    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer)));

    expectDestroyLifecycleWithTasks(harness.events);
    expectRecordedBracket(harness, "applied", {
      outcome: "destroyed",
      children: ["provider", "host-proxy", "routes"],
    });
    expect(harness.mutations.indexOf("inventory")).toBeGreaterThan(harness.mutations.indexOf("pre-destroy"));
    expect(harness.mutations.indexOf("inventory")).toBeLessThan(harness.mutations.indexOf("post-destroy"));
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.target).toEqual({ app: plan.id, plan });
    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: false, removeState: true });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
    expect(harness.volumes.has("lando-cache-npm")).toBe(true);
    expect(result.servicesDestroyed).toEqual(["database", "web"]);
    expect(renderDestroyAppResult(result)).toContain("destroyed: test-destroy");
    expect(renderDestroyAppResult(result)).toContain("volumes preserved");
  });

  test("uses the captured scratch AppRef when destroying a resolved scratch target", async () => {
    await withTempCwd(async (root) => {
      const scratchPlan: AppPlan = {
        ...plan,
        root: AbsolutePath.make(root),
        identity: { appRoot: AbsolutePath.make(root), ownerKey: ownerKey(root) },
      };
      const harness = makeDestroyLayer({ plannedApp: scratchPlan });
      const scratchRef = { kind: "scratch" as const, id: scratchPlan.id, root: scratchPlan.root };

      await Effect.runPromise(
        destroyApp({}, { plan: scratchPlan, root: scratchPlan.root, app: scratchRef }).pipe(
          Effect.provide(harness.layer),
        ),
      );

      expect(harness.publishedEvents.find((event) => event._tag === "pre-destroy")).toMatchObject({
        app: scratchRef,
        evidence: "applied",
      });
      expect(harness.publishedEvents.find((event) => event._tag === "post-destroy")).toMatchObject({
        app: scratchRef,
        evidence: "applied",
        outcome: "destroyed",
      });
    });
  });

  test("cleans host-proxy artifacts under the resolved PathsService roots", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-destroy-host-proxy-paths-")));
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    try {
      process.env.LANDO_USER_DATA_ROOT = join(root, "leaked-default-data");
      const dataRoot = join(root, "service-data");
      const hostProxyDir = makeLandoPaths({
        userDataRoot: dataRoot,
        platform: "linux",
      }).hostProxyRunDir(plan.id, plan.root);
      await mkdir(hostProxyDir, { recursive: true });
      const harness = makeDestroyLayer({ userDataRoot: dataRoot });

      await Effect.runPromise(destroyApp().pipe(Effect.provide(harness.layer)));

      await expectMissingPath(hostProxyDir);
    } finally {
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes app-scoped volumes when volumes: true is requested", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(destroyApp({ volumes: true }).pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls[0]?.options).toEqual({ volumes: true, removeState: true });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(false);
    expect(harness.volumes.has("lando-cache-npm")).toBe(true);
    expect(renderDestroyAppResult(result)).toContain("volumes removed");
  });

  test("removes cache volumes only when purgeCaches is requested", async () => {
    const harness = makeDestroyLayer();
    const result = await Effect.runPromise(
      destroyApp({ purgeCaches: true }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.destroyCalls[0]?.options).toEqual({
      volumes: false,
      purgeCaches: true,
      removeState: true,
    });
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
    expect(harness.volumes.has("lando-cache-npm")).toBe(false);
    expect(renderDestroyAppResult(result)).toContain("volumes removed");
  });

  test("--purge removes only this folder's snapshots and provider artifacts", async () => {
    await withTempCwd(async (dataRoot) => {
      const harness = makeDestroyLayer({ userDataRoot: dataRoot });
      const owned = await seedSnapshot(harness, dataRoot, { id: "owned", sourceRoot: plan.root });
      const sibling = await seedSnapshot(harness, dataRoot, {
        id: "sibling",
        sourceRoot: join(dataRoot, "other-worktree"),
      });
      const legacy = await seedSnapshot(harness, dataRoot, { id: "legacy" });
      const result = await Effect.runPromise(
        runDestroyCommand({ flags: { purge: true, yes: true } }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.snapshotsRemoved).toBe(1);
      expect(harness.destroyCalls[0]?.options.volumes).toBe(true);
      expect(harness.removedSnapshots).toEqual([owned.info.id]);
      expect(await Bun.file(owned.sidecar).exists()).toBe(false);
      expect(await Bun.file(sibling.sidecar).exists()).toBe(true);
      expect(await Bun.file(legacy.sidecar).exists()).toBe(true);
      const listed = await Effect.runPromise(
        DataMover.use((mover) => mover.listSnapshots({ app: plan.id })).pipe(Effect.provide(harness.layer)),
      );
      // Equal creation times list by id.
      expect(listed.map((info) => info.id)).toEqual([legacy.info.id, sibling.info.id]);
      expect(renderDestroyAppResult(result)).toBe(
        "destroyed: test-destroy - database, web (volumes and 1 snapshot removed)",
      );
    });
  });

  test("snapshot purge failure preserves retry handles and prevents provider teardown", async () => {
    await withTempCwd(async (dataRoot) => {
      const failure = new ProviderUnavailableError({
        providerId: "docker",
        operation: "removeVolumeSnapshot",
        message: "offline",
      });
      const harness = makeDestroyLayer({
        userDataRoot: dataRoot,
        removeSnapshotEffect: Effect.fail(failure),
      });
      const owned = await seedSnapshot(harness, dataRoot, { id: "retry", sourceRoot: plan.root });
      const result = await Effect.runPromise(
        destroyApp({ purgeSnapshots: true }).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataTransferError" } });
      expect(harness.destroyCalls).toEqual([]);
      expect(harness.events).not.toContain("post-destroy");
      expect(harness.publishedEvents.find((event) => event._tag === "pre-destroy")).toMatchObject({
        evidence: "applied",
      });
      expect(await Bun.file(owned.sidecar).exists()).toBe(true);
      const listed = await Effect.runPromise(
        DataMover.use((mover) => mover.listSnapshots({ app: plan.id })).pipe(Effect.provide(harness.layer)),
      );
      expect(listed.map((info) => info.id)).toEqual([owned.info.id]);
    });
  });

  test.each([false, true])(
    "purges snapshots with inventory-only evidence (missing root: %s)",
    async (missingRoot) => {
      // Given: inventory remains but every runtime resource is already absent.
      await withTempCwd(async (dataRoot) => {
        const root = missingRoot ? join(dataRoot, "gone") : testAppRoot;
        const harness = makeDestroyLayer({
          userDataRoot: dataRoot,
          plannedApp: { ...plan, root: AbsolutePath.make(root) },
          ownedEvidence: true,
        });
        const owned = await seedSnapshot(harness, dataRoot, { id: "inventory-snapshot", sourceRoot: root });
        const io = createBufferedRendererIO();

        // When: the real destroy command is invoked with purge.
        await withCwd(missingRoot ? dataRoot : root, () =>
          runDestroyCli(["--purge", "--yes", ...(missingRoot ? ["--root", root] : [])], harness, io, "json"),
        );

        // Then: snapshot deletion alone makes this a changed teardown.
        expect(JSON.parse(io.stdout())).toMatchObject({
          ok: true,
          result: { outcome: "destroyed", snapshotsRemoved: 1, servicesDestroyed: [], volumesRemoved: false },
        });
        expect(harness.removedSnapshots).toEqual([owned.info.id]);
      });
    },
  );

  test.each([false, true])(
    "purges snapshots without runtime resources (missing root: %s)",
    async (missingRoot) => {
      await withTempCwd(async (dataRoot) => {
        const root = missingRoot ? join(dataRoot, "gone") : testAppRoot;
        const desired = { ...plan, root: AbsolutePath.make(root) };
        const harness = makeDestroyLayer({ userDataRoot: dataRoot, plannedApp: desired, absent: true });
        const owned = await seedSnapshot(harness, dataRoot, { id: "snapshot-only", sourceRoot: root });
        const result = await withCwd(missingRoot ? dataRoot : root, () =>
          Effect.runPromise(
            (missingRoot
              ? runDestroyCommand({ flags: { root, purge: true, yes: true } })
              : destroyApp({ purgeSnapshots: true })
            ).pipe(Effect.provide(harness.layer)),
          ),
        );
        expect(result).toMatchObject({ outcome: "destroyed", servicesDestroyed: [], snapshotsRemoved: 1 });
        expectRecordedBracket(harness, "snapshots", { outcome: "destroyed", children: ["snapshots"] });
        expect(harness.destroyCalls).toEqual([]);
        expect(await Bun.file(owned.sidecar).exists()).toBe(false);
        expect(renderDestroyAppResult(result)).toBe(`destroyed: ${result.app} (1 snapshot removed)`);
      });
    },
  );

  test.each([false, true])(
    "purges snapshots alongside orphan teardown (missing root: %s)",
    async (missingRoot) => {
      await withTempCwd(async (dataRoot) => {
        const root = missingRoot ? join(dataRoot, "gone") : testAppRoot;
        const harness = makeDestroyLayer({
          userDataRoot: dataRoot,
          plannedApp: { ...plan, root: AbsolutePath.make(root) },
          orphanEvidence: true,
        });
        const owned = await seedSnapshot(harness, dataRoot, { id: "orphan-snapshot", sourceRoot: root });
        const result = missingRoot
          ? await Effect.runPromise(
              runDestroyCommand({ flags: { root, purge: true, yes: true } }).pipe(
                Effect.provide(harness.layer),
              ),
            )
          : await withCwd(root, () =>
              Effect.runPromise(destroyApp({ purgeSnapshots: true }).pipe(Effect.provide(harness.layer))),
            );
        expect(result).toMatchObject({
          outcome: "destroyed",
          servicesDestroyed: ["orphan"],
          snapshotsRemoved: 1,
        });
        expect(harness.removedSnapshots).toEqual([owned.info.id]);
        expect(await Bun.file(owned.sidecar).exists()).toBe(false);
        expect(harness.mutations).toContain("remove:orphan");
        expectRecordedBracket(harness, "orphans", {
          outcome: "destroyed",
          children: ["snapshots", "provider"],
        });
      });
    },
  );

  test("plain destroy preserves snapshots across volume and cache removal", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-destroy-snapshots-"));
    const snapshotRoot = makeLandoPaths({
      userDataRoot: dataRoot,
      platform: "linux",
    }).ownerSnapshotsDir(ownerKey(plan.root));
    await mkdir(join(snapshotRoot, "data"), { recursive: true });

    try {
      await Effect.runPromise(
        destroyApp().pipe(Effect.provide(makeDestroyLayer({ userDataRoot: dataRoot }).layer)),
      );
      expect(existsSync(snapshotRoot)).toBe(true);

      await Effect.runPromise(
        destroyApp({ purgeCaches: true }).pipe(
          Effect.provide(makeDestroyLayer({ userDataRoot: dataRoot }).layer),
        ),
      );
      expect(existsSync(snapshotRoot)).toBe(true);

      await Effect.runPromise(
        destroyApp({ volumes: true }).pipe(
          Effect.provide(makeDestroyLayer({ userDataRoot: dataRoot }).layer),
        ),
      );
      expect(existsSync(snapshotRoot)).toBe(true);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test.each([{}, { volumes: true }, { purgeCaches: true }])(
    "keeps catalogued snapshots without purgeSnapshots (%j)",
    async (options) => {
      await withTempCwd(async (dataRoot) => {
        const harness = makeDestroyLayer({ userDataRoot: dataRoot });
        const owned = await seedSnapshot(harness, dataRoot, { id: "preserved", sourceRoot: plan.root });
        const result = await Effect.runPromise(destroyApp(options).pipe(Effect.provide(harness.layer)));
        expect(result.snapshotsRemoved).toBe(0);
        expect(harness.removedSnapshots).toEqual([]);
        expect(await Bun.file(owned.sidecar).exists()).toBe(true);
        const listed = await Effect.runPromise(
          DataMover.use((mover) => mover.listSnapshots({ ownerKey: ownerKey(plan.root) })).pipe(
            Effect.provide(harness.layer),
          ),
        );
        expect(listed.map((info) => info.id)).toEqual([owned.info.id]);
      });
    },
  );

  test.each([1, 2])("renders snapshot-only and combined removal counts (%s)", (count) => {
    const result = { app: "shop", servicesDestroyed: [], volumesRemoved: false, snapshotsRemoved: count };
    const snapshots = `${count} snapshot${count === 1 ? "" : "s"}`;
    expect(renderDestroyAppResult(result)).toBe(`destroyed: shop (${snapshots} removed)`);
    expect(
      renderDestroyAppResult({ ...result, servicesDestroyed: ["database", "web"], volumesRemoved: true }),
    ).toBe(`destroyed: shop - database, web (volumes and ${snapshots} removed)`);
  });

  test("compiled CLI accepts lando destroy --volumes before missing Landofile resolution", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--volumes", "-y"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("LandofileNotFoundError");
    });
  });

  test("compiled CLI accepts lando destroy --purge before missing Landofile resolution", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--purge", "-y"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("LandofileNotFoundError");
    });
  });

  test("compiled CLI accepts lando destroy --purge-caches before missing Landofile resolution", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "--purge-caches", "-y"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("LandofileNotFoundError");
    });
  });

  test("preserves the missing Landofile error outside an app directory", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["destroy", "-y"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("LandofileNotFoundError");
      expect(result.stderr).toContain("Run `lando init --full --name=<name>` to scaffold an app.");
    });
  });

  test("renders an explicit unchanged outcome after complete provider evidence", () => {
    expect(
      renderDestroyAppResult({
        app: "test-destroy",
        outcome: "unchanged",
        servicesDestroyed: [],
        volumesRemoved: false,
        snapshotsRemoved: 0,
      }),
    ).toBe("unchanged: test-destroy - no services");
  });

  test("skips file-sync cleanup when the engine is unavailable and still destroys the app", async () => {
    const callLog: string[] = [];
    const unavailableEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(false),
      setup: () => Effect.void,
      createSession: () => Effect.succeed(FileSyncSessionRef.make("session-created")),
      flushSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          callLog.push("terminate");
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return [];
        }),
      streamEvents: () => Stream.empty,
    });
    const harness = makeDestroyLayer();
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, unavailableEngine));

    const result = await Effect.runPromise(destroyApp().pipe(Effect.provide(layer)));
    expect(result.app).toBe("test-destroy");
    expect(callLog).not.toContain("listSessions");
    expect(harness.destroyCalls).toHaveLength(1);
  });

  test("preserves provider resources when file-sync session listing fails", async () => {
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.succeed(FileSyncSessionRef.make("session-created")),
      flushSession: () => Effect.void,
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          callLog.push("terminate");
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
        }).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new FileSyncStopError({
                engineId: "mutagen",
                sessionRef: FileSyncSessionRef.make("session-web-app-mount"),
                message: "daemon unavailable",
              }),
            ),
          ),
        ),
      streamEvents: () => Stream.empty,
    });
    const harness = makeDestroyLayer({
      appliedFileSync: {
        status: "accelerated",
        engineId: "mutagen",
        sessions: [testSessionSpec("app-mount")],
      },
    });
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    const error = await Effect.runPromise(
      destroyApp({ volumes: true }).pipe(Effect.provide(layer), Effect.flip),
    );

    expect(error._tag).toBe("FileSyncStopError");
    expect(callLog).toEqual(["listSessions"]);
    expect(harness.destroyCalls).toHaveLength(0);
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
  });

  test("preserves provider resources when file-sync session termination fails", async () => {
    const existingRefs: ReadonlyArray<FileSyncSessionRef> = [
      FileSyncSessionRef.make("session-web-app-mount"),
      FileSyncSessionRef.make("session-web-cache-mount"),
    ];
    const existing: ReadonlyArray<FileSyncSessionInfo> = existingRefs.map((ref, index) => ({
      ref,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: web.name,
      mountKey: index === 0 ? "app-mount" : "cache-mount",
      spec: testSessionSpec(index === 0 ? "app-mount" : "cache-mount"),
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-05-29T00:00:00Z"),
    }));
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.succeed(FileSyncSessionRef.make("session-created")),
      flushSession: (ref) =>
        Effect.sync(() => {
          callLog.push(`flush:${String(ref)}`);
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: (ref) =>
        Effect.sync(() => {
          callLog.push(`terminate:${String(ref)}`);
          return ref === existingRefs[0];
        }).pipe(
          Effect.flatMap((shouldFail) =>
            shouldFail
              ? Effect.fail(
                  new FileSyncStopError({
                    engineId: "mutagen",
                    sessionRef: String(ref),
                    message: "daemon unavailable",
                  }),
                )
              : Effect.void,
          ),
        ),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return existing;
        }),
      streamEvents: () => Stream.empty,
    });
    const harness = makeDestroyLayer({
      appliedFileSync: {
        status: "accelerated",
        engineId: "mutagen",
        sessions: existing.map((session) => session.spec),
      },
      quiesceEffect: Effect.sync(() => {
        callLog.push("provider.quiesce");
      }),
    });
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    const error = await Effect.runPromise(
      destroyApp({ volumes: true }).pipe(Effect.provide(layer), Effect.flip),
    );

    expect(error._tag).toBe("FileSyncStopError");
    expect(callLog).toEqual([
      "listSessions",
      "provider.quiesce",
      "listSessions",
      `flush:${String(existingRefs[0])}`,
      `flush:${String(existingRefs[1])}`,
      `terminate:${String(existingRefs[0])}`,
    ]);
    expect(harness.destroyCalls).toHaveLength(0);
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
  });

  test("preserves provider volumes when file-sync flush fails", async () => {
    const ref = FileSyncSessionRef.make("session-web-app-mount");
    const existing: FileSyncSessionInfo = {
      ref,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: web.name,
      mountKey: "app-mount",
      spec: testSessionSpec("app-mount"),
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-05-29T00:00:00Z"),
    };
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.succeed(ref),
      flushSession: () =>
        Effect.sync(() => {
          callLog.push("flush");
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new FileSyncStopError({
                engineId: "mutagen",
                sessionRef: String(ref),
                message: "flush unavailable",
              }),
            ),
          ),
        ),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: () =>
        Effect.sync(() => {
          callLog.push("terminate");
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return [existing];
        }),
      streamEvents: () => Stream.empty,
    });
    const harness = makeDestroyLayer({
      appliedFileSync: {
        status: "accelerated",
        engineId: "mutagen",
        sessions: [existing.spec],
      },
      quiesceEffect: Effect.sync(() => {
        callLog.push("provider.quiesce");
      }),
    });
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    const error = await Effect.runPromise(
      destroyApp({ volumes: true }).pipe(Effect.provide(layer), Effect.flip),
    );

    expect(error._tag).toBe("FileSyncStopError");
    expect(callLog).toEqual(["listSessions", "provider.quiesce", "listSessions", "flush"]);
    expect(harness.destroyCalls).toHaveLength(0);
    expect(harness.volumes.has("test_destroy_database_data")).toBe(true);
  });
  test("terminates active file-sync sessions before provider.destroy even when the current plan has none", async () => {
    const existingRef = FileSyncSessionRef.make("session-web-app-mount");
    const existing: FileSyncSessionInfo = {
      ref: existingRef,
      app: { kind: "user", id: plan.id, root: plan.root },
      service: web.name,
      mountKey: "app-mount",
      spec: testSessionSpec("app-mount"),
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-05-29T00:00:00Z"),
    };
    const callLog: string[] = [];
    const fakeEngine: FileSyncEngineShape = FileSyncEngine.of({
      id: "mutagen",
      displayName: "Fake Mutagen",
      capabilities: {
        modes: ["two-way-safe"],
        remoteAgentDeployment: "none",
        exclusionPatterns: false,
        conflictReporting: false,
        progressReporting: false,
      },
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      createSession: () => Effect.succeed(existingRef),
      flushSession: (ref) =>
        Effect.sync(() => {
          callLog.push(`flush:${String(ref)}`);
        }),
      pauseSession: () => Effect.void,
      resumeSession: () => Effect.void,
      terminateSession: (ref) =>
        Effect.sync(() => {
          callLog.push(`terminate:${String(ref)}`);
        }),
      listSessions: () =>
        Effect.sync(() => {
          callLog.push("listSessions");
          return [existing];
        }),
      streamEvents: () => Stream.empty,
    });
    const harness = makeDestroyLayer({
      appliedFileSync: {
        status: "accelerated",
        engineId: "mutagen",
        sessions: [existing.spec],
      },
      quiesceEffect: Effect.sync(() => {
        callLog.push("provider.quiesce");
      }),
      providerDestroyEffect: Effect.sync(() => {
        callLog.push("provider.destroy");
      }),
    });
    const layer = Layer.mergeAll(harness.layer, Layer.succeed(FileSyncEngine, fakeEngine));

    await Effect.runPromise(destroyApp().pipe(Effect.provide(layer)));

    expect(callLog).toEqual([
      "listSessions",
      "provider.quiesce",
      "listSessions",
      `flush:${String(existingRef)}`,
      `terminate:${String(existingRef)}`,
      "provider.destroy",
    ]);
    expect(harness.destroyCalls).toHaveLength(1);
  });
});
import { currentTestPlan, literalLandofile } from "../_support/value-contracts.ts";
