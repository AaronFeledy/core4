import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import type { EventError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import {
  AbsoluteContainerPath,
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type ApplyOptions,
  BuildOrchestrator,
  EventService,
  FileSyncEngine,
  LandofileService,
  PathsService,
  PluginRegistry,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  SecretStore,
  type SecretStoreShape,
  type ServiceRuntimeInfo,
  StateStore,
} from "@lando/sdk/services";
import { TestRouterService, TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";

import { makeLandoPaths } from "@lando/paths";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { GlobalAppServiceLive } from "../../src/global-app/service.ts";
import { applyTreeId } from "../../src/operations/start-progress.ts";
import { startApp } from "../../src/operations/start.ts";
import { ConfigServiceLive } from "../../src/services/config.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { makeShellRunnerLive } from "../../src/services/shell-runner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { NoopTransactionGuardLive } from "../services/landofile-layer.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  multiServiceApply: true,
  hostReachability: "emulated",
  bindMounts: true,
  bindMountPerformance: "native",
  hostProxy: { containerTargets: [{ os: "linux", arch: "x64" }] },
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "start-progress-topology.test",
  runtime: 4 as const,
};

export const web: ServicePlan = {
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

const testAppRoot = mkdtempSync(join(tmpdir(), "lando-test-start-"));
process.once("exit", () => rmSync(testAppRoot, { recursive: true, force: true }));

export const plan: AppPlan = {
  id: AppId.make("test-start"),
  name: "test-start",
  slug: "test-start",
  root: AbsolutePath.make(testAppRoot),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

export const byTag = <T extends LandoEvent["_tag"]>(events: ReadonlyArray<LandoEvent>, tag: T) =>
  events.filter((event): event is Extract<LandoEvent, { readonly _tag: T }> => event._tag === tag);

export const startOwnedParentIds = (events: ReadonlyArray<LandoEvent>): ReadonlyArray<string> =>
  byTag(events, "task.tree.start")
    .map((event) => event.parentId)
    .filter((parentId) => parentId.startsWith("start-"));

export const makeHarness = (
  options: {
    readonly plannedApp?: AppPlan;
    readonly stateStore?: ReturnType<typeof makeTestStateStore>;
    readonly applyEffect?: Effect.Effect<{ readonly changed: boolean }, ProviderUnavailableError>;
    readonly destroyEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly onRemoveRoutes?: () => void;
    readonly afterApplyRoutes?: Effect.Effect<void>;
    readonly onPrepareFileSync?: (plan: AppPlan) => void;
    readonly preparedFileSyncTargets?: (
      plan: AppPlan,
    ) => ReadonlyArray<import("@lando/sdk/schema").PreparedFileSyncTarget>;
    readonly fileSyncRollbackEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly onBuildApp?: (plan: AppPlan) => void;
    readonly onFileSyncRollback?: () => void;
    readonly onPublish?: (event: LandoEvent) => Effect.Effect<void, EventError>;
    readonly providerCanPrepareFileSync?: boolean;
    readonly providerCanInspectFileSync?: boolean;
    readonly appliedFileSyncState?: "missing" | "ordinary" | "accelerated" | "unknown";
    readonly fileSync?: typeof FileSyncEngine.Service;
    readonly secretStore?: SecretStoreShape;
    readonly onApply?: (plan: AppPlan, options?: ApplyOptions) => void;
    readonly listVolumes?: RuntimeProviderShape["listVolumes"];
    readonly locateVolume?: RuntimeProviderShape["locateVolume"];
    readonly onVolumeLock?: (key: string) => void;
    readonly onDestroy?: (...args: Parameters<RuntimeProviderShape["destroy"]>) => void;
  } = {},
) => {
  const plannedApp = options.plannedApp ?? plan;
  const stateStore = options.stateStore ?? makeTestStateStore();
  const events: LandoEvent[] = [];
  let signalApplyTreeStart = (): void => undefined;
  const applyTreeStarted = new Promise<void>((resolve) => {
    signalApplyTreeStart = resolve;
  });
  const appliedFileSyncState =
    options.providerCanInspectFileSync === false
      ? undefined
      : (options.appliedFileSyncState ??
        (options.providerCanPrepareFileSync === false ? undefined : "missing"));
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities,
    isAvailable: Effect.succeed(true),
    ...(appliedFileSyncState === undefined
      ? {}
      : {
          inspectAppliedFileSync: () =>
            Effect.succeed(
              appliedFileSyncState === "accelerated"
                ? {
                    status: "accelerated" as const,
                    engineId: plannedApp.fileSync[0]?.engineId ?? "mutagen",
                    sessions: plannedApp.fileSync.map(({ session }) => session),
                  }
                : { status: appliedFileSyncState },
            ),
        }),
    ...(options.providerCanPrepareFileSync === false
      ? {}
      : {
          prepareFileSyncTargets: (syncPlan: AppPlan) =>
            Effect.sync(() => {
              options.onPrepareFileSync?.(syncPlan);
              return {
                targets:
                  options.preparedFileSyncTargets?.(syncPlan) ??
                  syncPlan.fileSync.map(({ session }, index) => ({
                    session,
                    endpoint: {
                      _tag: "container" as const,
                      containerId: `sync-helper-${index}`,
                      path: AbsoluteContainerPath.make("/sync"),
                      volumeName:
                        session.target._tag === "volume" ? session.target.name : "unsupported-target",
                    },
                  })),
                rollback: Effect.sync(() => {
                  options.onFileSyncRollback?.();
                }).pipe(Effect.zipRight(options.fileSyncRollbackEffect ?? Effect.void)),
              };
            }),
        }),
    apply: (appliedPlan, applyOptions) =>
      Effect.sync(() => options.onApply?.(appliedPlan, applyOptions)).pipe(
        Effect.zipRight(options.applyEffect ?? Effect.succeed({ changed: true })),
      ),
    inspect: (target) =>
      Effect.succeed<ServiceRuntimeInfo>({
        app: plannedApp.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plannedApp.services[target.service]?.endpoints ?? [],
      }),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => options.onDestroy?.(target, destroyOptions)).pipe(
        Effect.zipRight(options.destroyEffect ?? Effect.void),
        Effect.as({ kind: "destroyed" as const }),
      ),
    listVolumes: options.listVolumes ?? TestRuntimeProvider.listVolumes,
    locateVolume:
      options.locateVolume ??
      ((ref) =>
        Effect.succeed({
          coordinationKey: JSON.stringify(["endpoint:test", ref.store]),
          nativeName: ref.store,
          identity: {
            coordinationKey: JSON.stringify(["endpoint:test", ref.store]),
            nativeName: ref.store,
            generation: "00000000-0000-4000-8000-000000000001",
            ownerRoot: plannedApp.root,
            origin: "created",
          },
        })),
    execStream: () => Stream.empty,
    logs: () => Stream.empty,
  };
  const runtimeProviderRegistry = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(provider),
  };
  const userDataRoot = mkdtempSync(join(tmpdir(), "lando-start-harness-"));
  const layer = Layer.mergeAll(
    PrivateFileAccessLive,
    Layer.succeed(StateStore, {
      ...stateStore.service,
      withLock: (key, body) =>
        Effect.sync(() => options.onVolumeLock?.(key)).pipe(
          Effect.zipRight(stateStore.service.withLock(key, body)),
        ),
    }),
    NoopTransactionGuardLive,
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: plannedApp.name, services: {} }) }),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot })),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plannedApp) }),
    Layer.succeed(RuntimeProviderRegistry, runtimeProviderRegistry),
    Layer.succeed(EventService, {
      publish: (event) =>
        Schema.is(LandoEventSchema)(event)
          ? Effect.sync(() => {
              events.push(event);
              if (event._tag === "task.tree.start" && event.parentId === applyTreeId(String(plannedApp.id))) {
                signalApplyTreeStart();
              }
            }).pipe(Effect.zipRight(options.onPublish?.(event) ?? Effect.void))
          : Effect.die(new TypeError(`Unexpected event in start progress topology test: ${event._tag}`)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
    Layer.succeed(RedactionService, {
      registerValues: registerRedactionValues,
      forProfile: (profile, redactionOptions) =>
        Effect.succeed(createStandaloneRedactor(profile, redactionOptions)),
    }),
    Layer.succeed(PluginRegistry, {
      list: Effect.succeed([]),
      load: () => Effect.die("not used"),
      loadServiceType: () => Effect.die("not used"),
      loadServiceFeature: () => Effect.die("not used"),
      loadAppFeature: () => Effect.die("not used"),
    }),
    ConfigServiceLive,
    FileSystemLive,
    GlobalAppServiceLive.pipe(Layer.provide(Layer.mergeAll(ConfigServiceLive, FileSystemLive))),
    Layer.succeed(RouterService, {
      ...TestRouterService,
      applyRoutes: (routes, app) =>
        TestRouterService.applyRoutes(routes, app).pipe(
          Effect.tap(() => options.afterApplyRoutes ?? Effect.void),
        ),
      removeRoutes: (app) =>
        Effect.sync(() => options.onRemoveRoutes?.()).pipe(
          Effect.zipRight(TestRouterService.removeRoutes(app)),
        ),
    }),
    makeShellRunnerLive(() => {
      throw new TypeError("Interactive shell IO is not used by start progress topology tests.");
    }),
    Layer.succeed(BuildOrchestrator, {
      build: (appPlan) => Effect.succeed(appPlan),
      buildApp: (appPlan) =>
        Effect.sync(() => {
          options.onBuildApp?.(appPlan);
        }),
    }),
    ...(options.secretStore === undefined ? [] : [Layer.succeed(SecretStore, options.secretStore)]),
    ...(options.fileSync === undefined ? [] : [Layer.succeed(FileSyncEngine, options.fileSync)]),
  );
  return { layer, events, applyTreeStarted, stateStore, runtimeProviderRegistry, userDataRoot };
};

export const runStart = (harness: ReturnType<typeof makeHarness>, plannedApp: AppPlan = plan) =>
  Effect.runPromise(
    startApp(
      {},
      {
        plan: plannedApp,
        root: plannedApp.root,
        app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );
