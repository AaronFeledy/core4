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
  AppPlan as AppPlanSchema,
  LoadScopedLandofile,
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
  GlobalAppService,
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
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { emptySnapshotsLayer } from "./data-mover-support.ts";

import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import * as GlobalAppServiceLayer from "../../src/global-app/service.ts";
import { applyTreeId } from "../../src/operations/start-progress.ts";
import { startApp } from "../../src/operations/start.ts";
import * as LandoConfigService from "../../src/services/config.ts";
import * as EnvironmentValueResolverLayer from "../../src/services/environment-value-resolver.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeEnvSecretStore } from "../../src/services/secret-store.ts";
import * as BunShellRunner from "../../src/services/shell-runner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import * as TestLandofileLayers from "../services/landofile-layer.ts";

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
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
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
  valueModel: 1,
  id: AppId.make("test-start"),
  name: "test-start",
  slug: "test-start",
  root: AbsolutePath.make(testAppRoot),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
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

/** Round-trips a plan through JSON the way provider applied state does, dropping Landofile events. */
export const appliedPlanRecord = ({ events: _events, ...plan }: AppPlan): AppPlan =>
  Schema.decodeUnknownSync(AppPlanSchema)(JSON.parse(JSON.stringify(Schema.encodeSync(AppPlanSchema)(plan))));

export const makeHarness = (
  options: {
    readonly plannedApp?: AppPlan;
    readonly appliedPlans?: ReadonlyArray<AppPlan>;
    readonly providerOverrides?: Partial<RuntimeProviderShape>;
    readonly selectProvider?: (target?: AppPlan | ProviderId) => Effect.Effect<RuntimeProviderShape>;
    readonly resolveAppliedPlan?: typeof RuntimeProviderRegistry.Service.resolveAppliedPlan;
    readonly resolveTeardownEvidence?: typeof RuntimeProviderRegistry.Service.resolveTeardownEvidence;
    readonly resourceOwnership?: typeof RuntimeProviderRegistry.Service.resourceOwnership;
    readonly stateStore?: ReturnType<typeof makeTestStateStore>;
    readonly applyEffect?: Effect.Effect<{ readonly changed: boolean }, ProviderUnavailableError>;
    readonly apply?: RuntimeProviderShape["apply"];
    readonly destroyEffect?: Effect.Effect<void, ProviderUnavailableError>;
    readonly onRemoveRoutes?: () => void;
    readonly afterApplyRoutes?: Effect.Effect<void>;
    readonly onPrepareFileSync?: (plan: AppPlan) => void;
    readonly preparedFileSyncTargets?: (
      plan: AppPlan,
    ) => ReadonlyArray<import("@lando/sdk/schema").PreparedFileSyncTarget>;
    readonly onBuildApp?: (plan: AppPlan) => void;
    readonly onPublish?: (event: LandoEvent) => Effect.Effect<void, EventError>;
    readonly providerCanPrepareFileSync?: boolean;
    readonly providerCanInspectFileSync?: boolean;
    readonly appliedFileSyncState?: "missing" | "ordinary" | "accelerated" | "unknown";
    readonly persistAppliedFileSync?: boolean;
    readonly appliedFileSyncSessions?: ReadonlyArray<import("@lando/sdk/schema").FileSyncSessionSpec>;
    readonly fileSync?: typeof FileSyncEngine.Service;
    readonly secretStore?: SecretStoreShape;
    readonly onApply?: (
      plan: AppPlan,
      options?: ApplyOptions,
    ) => void | number | Effect.Effect<void, import("@lando/sdk/services").ProviderError>;
    readonly onStop?: (...args: Parameters<RuntimeProviderShape["stop"]>) => void;
    readonly inspect?: RuntimeProviderShape["inspect"];
    readonly exec?: RuntimeProviderShape["exec"];
    readonly logs?: RuntimeProviderShape["logs"];
    readonly listVolumes?: RuntimeProviderShape["listVolumes"];
    readonly locateVolume?: RuntimeProviderShape["locateVolume"];
    readonly onVolumeLock?: (key: string) => void;
    readonly onDestroy?: (...args: Parameters<RuntimeProviderShape["destroy"]>) => void;
    readonly quiesceRetainedFileSync?: RuntimeProviderShape["quiesceRetainedFileSync"];
    readonly disposeFileSyncTargets?: RuntimeProviderShape["disposeFileSyncTargets"];
  } = {},
) => {
  const redaction = makeRedactionService();
  const plannedApp = options.plannedApp ?? plan;
  const stateStore = options.stateStore ?? makeTestStateStore();
  const events: LandoEvent[] = [];
  let signalApplyTreeStart = (): void => undefined;
  const applyTreeStarted = new Promise<void>((resolve) => {
    signalApplyTreeStart = resolve;
  });
  let appliedFileSyncState =
    options.providerCanInspectFileSync === false
      ? undefined
      : (options.appliedFileSyncState ??
        (options.providerCanPrepareFileSync === false ? undefined : "missing"));
  const apply =
    options.apply ??
    ((appliedPlan: AppPlan, applyOptions: ApplyOptions) =>
      Effect.forEach(
        Object.values(appliedPlan.services),
        (service) => applyOptions.resolveServiceEnvironment?.(service) ?? Effect.succeed(service.environment),
      ).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const result = options.onApply?.(appliedPlan, applyOptions);
            return Effect.isEffect(result) ? result : Effect.void;
          }),
        ),
        Effect.andThen(options.applyEffect ?? Effect.succeed({ changed: true })),
      ));
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    ...options.providerOverrides,
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
                    sessions:
                      options.appliedFileSyncSessions ?? plannedApp.fileSync.map(({ session }) => session),
                  }
                : { status: appliedFileSyncState ?? "missing" },
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
              };
            }),
        }),
    quiesceForFileSync: () => Effect.void,
    ...(options.quiesceRetainedFileSync === undefined
      ? {}
      : { quiesceRetainedFileSync: options.quiesceRetainedFileSync }),
    ...(options.disposeFileSyncTargets === undefined
      ? {}
      : { disposeFileSyncTargets: options.disposeFileSyncTargets }),
    apply: (appliedPlan, applyOptions) =>
      apply(appliedPlan, applyOptions).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (options.persistAppliedFileSync === true)
              appliedFileSyncState = appliedPlan.fileSync.length > 0 ? "accelerated" : "ordinary";
          }),
        ),
      ),
    inspect:
      options.inspect ??
      ((target) =>
        Effect.succeed<ServiceRuntimeInfo>({
          app: plannedApp.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
          publications: {
            status: "present",
            bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 3000 }],
          },
        })),
    stop: (target) =>
      Effect.sync(() => {
        options.onStop?.(target);
      }),
    destroy: (target, destroyOptions) =>
      Effect.sync(() => options.onDestroy?.(target, destroyOptions)).pipe(
        Effect.andThen(options.destroyEffect ?? Effect.void),
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
    exec: options.exec ?? TestRuntimeProvider.exec,
    logs: options.logs ?? (() => Stream.empty),
  };
  const runtimeProviderRegistry = {
    appliedPlansFor: (root: AbsolutePath) =>
      Effect.succeed((options.appliedPlans ?? []).filter((plan) => plan.identity?.appRoot === root)),
    ...(options.resourceOwnership === undefined ? {} : { resourceOwnership: options.resourceOwnership }),
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: options.selectProvider ?? (() => Effect.succeed(provider)),
    // What a provider really hands back: a decoded record, never the planner's object, with no events.
    resolveAppliedPlan: options.resolveAppliedPlan ?? (() => Effect.succeed(appliedPlanRecord(plannedApp))),
    resolveTeardownEvidence:
      options.resolveTeardownEvidence ??
      ((root: AbsolutePath) =>
        (options.resolveAppliedPlan ?? (() => Effect.succeed(appliedPlanRecord(plannedApp))))(root).pipe(
          Effect.map((plan) =>
            plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan },
          ),
        )),
  };
  const userDataRoot = mkdtempSync(join(tmpdir(), "lando-start-harness-"));
  const layer = Layer.mergeAll(
    emptySnapshotsLayer,
    PrivateFileAccessService.layer,
    Layer.succeed(
      StateStore,
      StateStore.of({
        ...stateStore.service,
        withLock: (key, body) =>
          Effect.sync(() => options.onVolumeLock?.(key)).pipe(
            Effect.andThen(stateStore.service.withLock(key, body)),
          ),
      }),
    ),
    TestLandofileLayers.layerTransactionGuard,
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          LoadScopedLandofile.make({
            stage: "load-scoped",
            document: { name: plannedApp.name, services: {} },
            pendingSites: [],
            context: { appRoot: plannedApp.root, env: {} },
          }),
        ),
      }),
    ),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({ plan: () => Effect.succeed({ ...plannedApp, valueModel: 1 as const }) }),
    ),
    Layer.succeed(RuntimeProviderRegistry, runtimeProviderRegistry),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Schema.is(LandoEventSchema)(event)
            ? Effect.sync(() => {
                events.push(event);
                if (
                  event._tag === "task.tree.start" &&
                  event.parentId === applyTreeId(String(plannedApp.id))
                ) {
                  signalApplyTreeStart();
                }
              }).pipe(Effect.andThen(options.onPublish?.(event) ?? Effect.void))
            : Effect.die(new TypeError(`Unexpected event in start progress topology test: ${event._tag}`)),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        ...redaction,
      }),
    ),
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
    Layer.effect(
      GlobalAppService,
      Effect.map(GlobalAppService, (service) => ({ ...service, providerId: Effect.succeed(providerId) })),
    ).pipe(
      Layer.provide(
        GlobalAppServiceLayer.layer.pipe(
          Layer.provide(Layer.mergeAll(LandoConfigService.layer, BunFileSystem.layer)),
        ),
      ),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...TestRouterService,
        applyRoutes: (routes, app) =>
          TestRouterService.applyRoutes(routes, app).pipe(
            Effect.tap(() => options.afterApplyRoutes ?? Effect.void),
          ),
        removeRoutes: (app) =>
          Effect.sync(() => options.onRemoveRoutes?.()).pipe(
            Effect.andThen(TestRouterService.removeRoutes(app)),
          ),
      }),
    ),
    BunShellRunner.layer(() => {
      throw new TypeError("Interactive shell IO is not used by start progress topology tests.");
    }),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (appPlan) => Effect.succeed(appPlan),
        buildApp: (appPlan) =>
          Effect.sync(() => {
            options.onBuildApp?.(appPlan);
          }),
      }),
    ),
    EnvironmentValueResolverLayer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SecretStore, options.secretStore ?? makeEnvSecretStore()),
          Layer.succeed(RedactionService, redaction),
        ),
      ),
    ),
    ...(options.secretStore === undefined ? [] : [Layer.succeed(SecretStore, options.secretStore)]),
    ...(options.fileSync === undefined ? [] : [Layer.succeed(FileSyncEngine, options.fileSync)]),
    // After LandoConfigService.layer: that snapshot also provides PathsService, and the later layer wins.
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot })),
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
