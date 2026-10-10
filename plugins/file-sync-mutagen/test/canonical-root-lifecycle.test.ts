import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import * as GlobalAppServiceLayer from "@lando/engine/global-app/service";
import { destroyAppForTarget } from "@lando/engine/operations/destroy";
import { startApp } from "@lando/engine/operations/start";
import { stopAppForTarget } from "@lando/engine/operations/stop";
import * as LandoConfigService from "@lando/engine/services/config";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as BunShellRunner from "@lando/engine/services/shell-runner";
import { testRedactionLayer } from "@lando/engine/testing/redaction";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import {
  AbsoluteContainerPath,
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionSpec,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  EventService,
  FileSyncEngine,
  LandofileService,
  ManagedFileTransactionGuard,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { makeFakeMutagenClient, makeFileSyncEngine, mutagenSessionName } from "../src/index.ts";

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "canonical-root-lifecycle.test",
  runtime: 4 as const,
};

const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: 3000,
      protocol: "http",
      name: "http",
      publication: { hostPort: 3000 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const acceleratedPlanFor = (root: AbsolutePath): AppPlan => {
  const id = AppId.make("canonical-sync");
  const app = { kind: "user" as const, id, root };
  const session: FileSyncSessionSpec = {
    app,
    service: web.name,
    mountKey: "app-mount",
    source: root,
    target: { _tag: "volume", name: "canonical-sync-web-app-mount", path: PortablePath.make("/app") },
    mode: "two-way-safe",
    excludes: [],
  };
  return {
    id,
    name: "canonical-sync",
    slug: "canonical-sync",
    root,
    provider: providerId,
    services: {
      [web.name]: {
        ...web,
        appMount: {
          source: root,
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "accelerated",
          excludes: [],
          includes: [],
        },
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [{ engineId: "mutagen", session }],
    metadata,
    extensions: {},
  };
};

const makeHarness = (plannedApp: AppPlan, fileSync: typeof FileSyncEngine.Service) => {
  const stateStore = makeTestStateStore();
  const events: LandoEvent[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities: { ...TestRuntimeProvider.capabilities, multiServiceApply: true },
    isAvailable: Effect.succeed(true),
    inspectAppliedFileSync: () =>
      Effect.succeed({
        status: "accelerated" as const,
        engineId: "mutagen",
        sessions: plannedApp.fileSync.map(({ session }) => session),
      }),
    prepareFileSyncTargets: (syncPlan) =>
      Effect.succeed({
        targets: syncPlan.fileSync.map(({ session }, index) => ({
          session,
          endpoint: {
            _tag: "container" as const,
            containerId: `sync-helper-${index}`,
            path: AbsoluteContainerPath.make("/sync"),
            volumeName: session.target._tag === "volume" ? session.target.name : "unsupported-target",
          },
        })),
        rollback: Effect.void,
      }),
    quiesceForFileSync: () => Effect.void,
    apply: () => Effect.succeed({ changed: true }),
    inspect: (target) =>
      Effect.succeed({
        app: plannedApp.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plannedApp.services[target.service]?.endpoints ?? [],
      }),
    stop: () => Effect.void,
    destroy: () => Effect.succeed({ kind: "destroyed" as const }),
    execStream: () => Stream.empty,
    logs: () => Stream.empty,
  };
  const userDataRoot = mkdtempSync(join(tmpdir(), "lando-canonical-lifecycle-"));
  const layer = Layer.mergeAll(
    PrivateFileAccessService.layer,
    Layer.succeed(StateStore, stateStore.service),
    Layer.succeed(
      ManagedFileTransactionGuard,
      ManagedFileTransactionGuard.of({
        ensureConsistent: () => Effect.void,
        pending: () => Effect.succeed(null),
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({ discover: Effect.succeed({ name: plannedApp.name, services: {} }) }),
    ),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot })),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plannedApp) })),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Schema.is(LandoEventSchema)(event)
            ? Effect.sync(() => {
                events.push(event);
              })
            : Effect.die(new TypeError(`Unexpected event: ${event._tag}`)),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
    testRedactionLayer,
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed([]),
        load: () => Effect.die("not used"),
        loadServiceType: () => Effect.die("not used"),
        loadServiceFeature: () => Effect.die("not used"),
        loadAppFeature: () => Effect.die("not used"),
      }),
    ),
    LandoConfigService.layer,
    BunFileSystem.layer,
    GlobalAppServiceLayer.layer.pipe(
      Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
    ),
    Layer.succeed(RouterService, TestRouterService),
    BunShellRunner.layer(() => {
      throw new TypeError("Interactive shell IO is not used by canonical-root lifecycle tests.");
    }),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (appPlan) => Effect.succeed(appPlan),
        buildApp: () => Effect.void,
      }),
    ),
    Layer.succeed(FileSyncEngine, fileSync),
  );
  return { layer, events, userDataRoot };
};

const targetFor = (plannedApp: AppPlan) => ({
  plan: plannedApp,
  root: plannedApp.root,
  app: { kind: "user" as const, id: plannedApp.id, root: plannedApp.root },
});

describe("canonical-root file-sync lifecycle", () => {
  test("start, stop, then start again with a fake Mutagen client", async () => {
    const canonical = AbsolutePath.make(
      await realpath(await mkdtemp(join(tmpdir(), "lando-canonical-life-"))),
    );
    const plannedApp = acceleratedPlanFor(canonical);
    const client = makeFakeMutagenClient();
    const engine = makeFileSyncEngine({ client });
    const harness = makeHarness(plannedApp, engine);
    const target = targetFor(plannedApp);
    try {
      await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
      expect(client.state.sessions.size).toBe(1);
      await Effect.runPromise(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
      expect(client.state.sessions.size).toBe(0);
      await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
      expect(client.state.sessions.size).toBe(1);
      const created = [...client.state.sessions.values()][0];
      expect(created?.spec.app.root).toBe(canonical);
      expect(created?.spec.source).toBe(canonical);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
      await rm(canonical, { recursive: true, force: true });
    }
  });

  test("start, stop, then start again keeps a legacy short-path session from drifting", async () => {
    const canonical = AbsolutePath.make(
      await realpath(await mkdtemp(join(tmpdir(), "lando-canonical-life-"))),
    );
    const legacy = AbsolutePath.make(`${canonical}-short`);
    await symlink(canonical, legacy);
    const plannedApp = acceleratedPlanFor(canonical);
    const plannedSession = plannedApp.fileSync[0]?.session;
    if (plannedSession === undefined) throw new Error("Expected a planned file-sync session");
    const legacySession = {
      ...plannedSession,
      app: { ...plannedSession.app, root: legacy },
      source: legacy,
    };
    const client = makeFakeMutagenClient({
      initialSessions: [
        {
          name: mutagenSessionName(legacySession),
          status: "running",
          lastUpdatedAt: DateTime.makeUnsafe("2026-05-28T00:00:00Z"),
          spec: legacySession,
        },
      ],
    });
    const engine = makeFileSyncEngine({ client });
    const harness = makeHarness(plannedApp, engine);
    const target = targetFor(plannedApp);
    try {
      await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
      expect(client.state.calls.some((call) => call.op === "create")).toBe(false);
      expect(client.state.sessions.size).toBe(1);
      await Effect.runPromise(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
      expect(client.state.sessions.size).toBe(0);
      await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
      expect(client.state.sessions.size).toBe(1);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
      await rm(legacy, { force: true });
      await rm(canonical, { recursive: true, force: true });
    }
  });

  test("destroy succeeds for a legacy short-path session", async () => {
    const canonical = AbsolutePath.make(
      await realpath(await mkdtemp(join(tmpdir(), "lando-canonical-life-"))),
    );
    const legacy = AbsolutePath.make(`${canonical}-short`);
    await symlink(canonical, legacy);
    const plannedApp = acceleratedPlanFor(canonical);
    const plannedSession = plannedApp.fileSync[0]?.session;
    if (plannedSession === undefined) throw new Error("Expected a planned file-sync session");
    const legacySession = {
      ...plannedSession,
      app: { ...plannedSession.app, root: legacy },
      source: legacy,
    };
    const client = makeFakeMutagenClient({
      initialSessions: [
        {
          name: mutagenSessionName(legacySession),
          status: "running",
          lastUpdatedAt: DateTime.makeUnsafe("2026-05-28T00:00:00Z"),
          spec: legacySession,
        },
      ],
    });
    const engine = makeFileSyncEngine({ client });
    const harness = makeHarness(plannedApp, engine);
    const target = targetFor(plannedApp);
    try {
      const destroyResult = await Effect.runPromise(
        destroyAppForTarget({}, target).pipe(Effect.provide(harness.layer)),
      );
      expect(destroyResult.app).toBe("canonical-sync");
      expect(client.state.sessions.size).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
      await rm(legacy, { force: true });
      await rm(canonical, { recursive: true, force: true });
    }
  });
});
