import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { LandofileValidationError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  FileSyncSessionRef,
  PortablePath,
  ProviderId,
  type ResourceOwnership,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { AppliedOrphanGroup, ListFilter, ServiceRuntimeInfo } from "@lando/sdk/services";
import {
  AppPlanner,
  EventService,
  LandofileService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import {
  beginOrResumeAcceleratedStart,
  readJournal,
} from "../../src/operations/accelerated-start-journal.ts";
import { HeldAppLockKeys, withAppMutationLock } from "../../src/operations/app-mutation-lock.ts";
import { stopAppAtRoot } from "../../src/operations/stop.ts";
import { FileSyncResolver } from "../../src/plugins/file-sync-resolver.ts";
import { TeardownProvider } from "../../src/providers/app-placement.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { withAcceleratedBind } from "../accelerated-plan.ts";
import { layerTransactionGuard } from "../services/landofile-layer.ts";
import { emptySnapshotsLayer } from "./data-mover-support.ts";
import { web } from "./destroy-progress-topology-support.ts";

const providerId = ProviderId.make("lando");
const otherProviderId = ProviderId.make("docker");
const dataRoot = await mkdtemp(join(tmpdir(), "lando-stop-at-root-data-"));
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

const ownerKey = (root: string): string => appIdentityKey("owner", root);

const planAt = (root: string, provider = providerId): AppPlan => ({
  id: AppId.make("stop-at-root"),
  name: "stop-at-root",
  slug: "stop-at-root",
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: ownerKey(root) },
  provider,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

const acceleratedPlanAt = (root: string): AppPlan =>
  withAcceleratedBind({ ...planAt(root), services: { [web.name]: web } }, web.name, {
    type: "bind",
    source: AbsolutePath.make(root),
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    mountKey: "app-mount",
    excludes: [],
  });

const orphanGroup = (root: string, services: ReadonlyArray<string>): AppliedOrphanGroup => ({
  providerId,
  appId: AppId.make("orphan-app"),
  services: services.map((name) => ({
    app: AppId.make("orphan-app"),
    appRoot: AbsolutePath.make(root),
    service: ServiceName.make(name),
    providerId,
    status: "running" as const,
    containerId: `container-${name}`,
    publications: { status: "unknown" as const },
  })),
  volumes: [],
});

const ownershipAt = (root: string): ResourceOwnership => ({
  appRoot: AbsolutePath.make(root),
  ownerKey: ownerKey(root),
  providerId,
  appIds: [AppId.make("owned-app")],
});

const invalidLandofile = new LandofileValidationError({
  message: "The current Landofile is invalid.",
  remediation: "Fix the current Landofile before applying it.",
  file: ".lando.yml",
  issues: [{ path: [], message: "invalid test fixture" }],
});

const makeHarness = (input: {
  readonly appliedPlan?: AppPlan;
  readonly orphans?: ReadonlyArray<AppliedOrphanGroup>;
  readonly ownership?: ReadonlyArray<ResourceOwnership>;
}) => {
  const destroyCalls: AppPlan[] = [];
  const removalAttempts: Array<{ readonly service: string; readonly containerId: string | undefined }> = [];
  const removedVolumes: string[] = [];
  const evidenceScopes: Array<ProviderId | undefined> = [];
  const appliedPlanReads: Array<ProviderId | undefined> = [];
  const routeRemovals: string[] = [];
  const statusReads: string[] = [];
  const cleanupRoots: string[] = [];
  const published: LandoEvent[] = [];
  const appliedPlan = input.appliedPlan;
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    getStatus: Effect.sync(() => {
      statusReads.push("lando");
      return { state: "running" as const };
    }),
    list: (_filter: ListFilter) => Effect.succeed([]),
    listVolumes: () => Effect.succeed([]),
    destroy: (target: { readonly app: string; readonly plan?: AppPlan }) =>
      Effect.sync(() => {
        if (target.plan !== undefined) destroyCalls.push(target.plan);
        return { kind: "destroyed" as const, volumesRemoved: { data: 0, cache: 0 } };
      }),
    removeObservedService: (service: ServiceRuntimeInfo) =>
      Effect.sync(() => {
        removalAttempts.push({
          service: String(service.service),
          containerId: service.containerId,
        });
        return { kind: "removed" as const };
      }),
    removeVolume: (ref: { readonly store: string }) =>
      Effect.sync(() => {
        removedVolumes.push(ref.store);
      }),
    cleanupOwnedResources: (root: AbsolutePath) =>
      Effect.sync(() => {
        cleanupRoots.push(root);
        return { servicesRemoved: ["owned-web"], networksRemoved: 0, volumesRemoved: 0 };
      }),
  };
  const registry = {
    appliedPlansFor: (root: AbsolutePath, scope?: ProviderId) => {
      appliedPlanReads.push(scope);
      return Effect.succeed(
        appliedPlan !== undefined &&
          appliedPlan.identity?.appRoot === root &&
          (scope === undefined || scope === appliedPlan.provider)
          ? [appliedPlan]
          : [],
      );
    },
    appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
    list: Effect.succeed([providerId, otherProviderId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(provider),
    resolveAppliedPlan: () => Effect.succeed(appliedPlan),
    resolveTeardownEvidence: (root: AbsolutePath) =>
      Effect.gen(function* () {
        const scope = yield* TeardownProvider;
        evidenceScopes.push(scope);
        if (appliedPlan !== undefined && appliedPlan.identity?.appRoot === root) {
          return scope === undefined || scope === appliedPlan.provider
            ? { kind: "applied" as const, plan: appliedPlan }
            : { kind: "absent" as const };
        }
        const groups = (input.orphans ?? []).filter((group) =>
          group.services.some((service) => service.appRoot === root),
        );
        if (groups.length > 0) return { kind: "orphans" as const, groups };
        if (input.ownership !== undefined) return { kind: "owned" as const, ownership: input.ownership };
        return { kind: "absent" as const };
      }),
    resourceOwnership: () => Effect.succeed(undefined),
    observeRuntime: Effect.succeed([]),
  };
  const router = RouterService.of({
    ...makeTestRouterService(),
    removeRoutes: (owner) =>
      Effect.sync(() => {
        routeRemovals.push(String(owner.id));
      }),
  });
  const layer = Layer.mergeAll(
    layerTransactionGuard,
    emptySnapshotsLayer,
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: dataRoot,
        userCacheRoot: join(dataRoot, "cache"),
        userConfRoot: join(dataRoot, "conf"),
        systemPluginRoot: join(dataRoot, "sys"),
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.fail(invalidLandofile),
      }),
    ),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: () => Effect.die("desired planning must not run unless a pending start needs it"),
      }),
    ),
    Layer.succeed(RuntimeProviderRegistry, registry as never),
    Layer.succeed(RouterService, router),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            if (Schema.is(LandoEventSchema)(event)) published.push(event);
          }),
        subscribe: () => Stream.die("not used"),
        subscribeQueue: Effect.die("not used"),
        waitFor: () => Effect.die("not used"),
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.die("not used"),
        query: () => Effect.succeed([]),
      }),
    ),
  );
  return {
    layer,
    destroyCalls,
    removalAttempts,
    removedVolumes,
    evidenceScopes,
    appliedPlanReads,
    routeRemovals,
    statusReads,
    cleanupRoots,
    published,
  };
};

const withTempRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-stop-at-root-")));
  await Bun.write(join(root, ".lando.yml"), "name: stop-at-root\n");
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("stopAppAtRoot", () => {
  test("stops an applied plan at an existing root and withdraws its routes", async () => {
    await withTempRoot(async (root) => {
      const applied = planAt(root);
      const harness = makeHarness({ appliedPlan: applied });
      const result = await Effect.runPromise(stopAppAtRoot(root).pipe(Effect.provide(harness.layer)));
      expect(result.outcome).toBe("stopped");
      expect(harness.destroyCalls).toEqual([applied]);
      expect(harness.routeRemovals).toEqual(["stop-at-root"]);
      expect(harness.statusReads).toEqual(["lando"]);
    });
  });

  test("removes orphan containers at a missing root and keeps named volumes", async () => {
    await withTempRoot(async (parent) => {
      const root = join(parent, "gone");
      const harness = makeHarness({ orphans: [orphanGroup(root, ["appserver", "database"])] });
      const result = await Effect.runPromise(stopAppAtRoot(root).pipe(Effect.provide(harness.layer)));
      expect(result.outcome).toBe("stopped");
      expect(harness.removalAttempts).toEqual([
        { service: "appserver", containerId: "container-appserver" },
        { service: "database", containerId: "container-database" },
      ]);
      expect(harness.removedVolumes).toEqual([]);
      expect(harness.routeRemovals).toEqual(["orphan-app"]);
      expect(harness.statusReads).toEqual([]);
    });
  });

  test("cleans owned resources at a root with no applied plan", async () => {
    await withTempRoot(async (root) => {
      const harness = makeHarness({ ownership: [ownershipAt(root)] });
      const result = await Effect.runPromise(stopAppAtRoot(root).pipe(Effect.provide(harness.layer)));
      expect(result).toMatchObject({ outcome: "stopped", servicesStopped: ["owned-web"] });
      expect(harness.cleanupRoots).toEqual([root]);
      expect(harness.routeRemovals).toEqual(["owned-app"]);
      expect(harness.destroyCalls).toEqual([]);
    });
  });

  test("reports unchanged for an absent root without loading desired config or touching a provider", async () => {
    await withTempRoot(async (root) => {
      const harness = makeHarness({});
      const result = await Effect.runPromise(stopAppAtRoot(root).pipe(Effect.provide(harness.layer)));
      expect(result).toEqual({ app: basename(root), outcome: "unchanged", servicesStopped: [] });
      expect(harness.destroyCalls).toEqual([]);
      expect(harness.removalAttempts).toEqual([]);
      expect(harness.statusReads).toEqual([]);
      expect(harness.appliedPlanReads).toEqual([]);
      expect(harness.published).toEqual([]);
    });
  });

  test("scopes every evidence read to the requested provider", async () => {
    await withTempRoot(async (root) => {
      const harness = makeHarness({ appliedPlan: planAt(root, otherProviderId) });
      const result = await Effect.runPromise(
        stopAppAtRoot(root, { providerId }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.outcome).toBe("unchanged");
      expect(harness.destroyCalls).toEqual([]);
      expect(harness.evidenceScopes).toEqual([providerId]);
    });
  });

  test("waits for a concurrent holder of the same root lock before resolving evidence", async () => {
    await withTempRoot(async (root) => {
      const harness = makeHarness({});
      const held = await Deferred.make<void>().pipe(Effect.runPromise);
      const release = await Deferred.make<void>().pipe(Effect.runPromise);
      const waiting = await Deferred.make<void>().pipe(Effect.runPromise);
      const events = Layer.succeed(
        EventService,
        EventService.of({
          publish: (event) =>
            Effect.suspend(() => {
              if (Schema.is(LandoEventSchema)(event) && event._tag === "message.warn")
                return Deferred.succeed(waiting, undefined).pipe(Effect.asVoid);
              return Effect.void;
            }),
          subscribe: () => Stream.die("not used"),
          subscribeQueue: Effect.die("not used"),
          waitFor: () => Effect.die("not used"),
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.die("not used"),
          query: () => Effect.succeed([]),
        }),
      );
      const layer = Layer.merge(harness.layer, events);
      const holder = Effect.runFork(
        withAppMutationLock(
          { kind: "user", id: root, root },
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.provideService(HeldAppLockKeys, new Set()), Effect.provide(layer)),
      );
      await Deferred.await(held).pipe(Effect.runPromise);
      try {
        const stop = Effect.runFork(stopAppAtRoot(root).pipe(Effect.provide(layer)));
        await Deferred.await(waiting).pipe(Effect.timeout("10 seconds"), Effect.runPromise);
        expect(harness.evidenceScopes).toEqual([]);
        await Deferred.succeed(release, undefined).pipe(Effect.runPromise);
        const result = await Effect.runPromise(Fiber.join(stop));
        expect(result.outcome).toBe("unchanged");
        expect(harness.evidenceScopes).toEqual([undefined]);
      } finally {
        await Effect.runPromise(Fiber.interrupt(holder));
      }
    });
  });

  test("terminates a missing-root unfinished start and keeps its journal, targets, and volumes", async () => {
    await withTempRoot(async (root) => {
      const plan = acceleratedPlanAt(root);
      const app = { kind: "user" as const, id: plan.id, root: plan.root };
      const terminations: string[] = [];
      const engine = {
        ...TestFileSyncEngine,
        id: "mutagen",
        listSessions: (filter: { readonly app?: { readonly id?: string; readonly root?: string } }) =>
          Effect.succeed(
            plan.fileSync
              .filter(
                (entry) =>
                  filter.app === undefined ||
                  (entry.session.app.id === filter.app.id && entry.session.app.root === filter.app.root),
              )
              .map((entry) => ({
                ...entry.session,
                ref: FileSyncSessionRef.make(`${entry.session.service}-${entry.session.mountKey}`),
                spec: entry.session,
                status: "running" as const,
                lastUpdatedAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
              })),
          ),
        terminateSession: (ref: unknown) =>
          Effect.sync(() => {
            terminations.push(String(ref));
          }),
      };
      const harness = makeHarness({});
      const layer = Layer.merge(
        harness.layer,
        Layer.succeed(FileSyncResolver, {
          candidates: [],
          select: () => Effect.succeed(undefined),
          acquire: () => Effect.succeed(engine),
        }),
      );
      await Effect.runPromise(
        beginOrResumeAcceleratedStart(plan, app).pipe(
          Effect.flatMap((pending) =>
            pending.advance("record-sessions").pipe(Effect.andThen(pending.advance("record-apply-intent"))),
          ),
          Effect.provide(layer),
        ),
      );
      await rm(root, { recursive: true, force: true });

      const result = await Effect.runPromise(stopAppAtRoot(root).pipe(Effect.provide(layer)));
      expect(result).toMatchObject({ app: "stop-at-root", outcome: "stopped", servicesStopped: [] });
      expect(terminations).toHaveLength(1);
      expect(harness.destroyCalls).toEqual([]);
      expect(harness.statusReads).toEqual([]);
      expect(harness.removedVolumes).toEqual([]);
      const journal = await Effect.runPromise(readJournal(app).pipe(Effect.provide(layer)));
      expect(journal.pending).not.toBeNull();
      expect(journal.pending?.phase).not.toBe("completed");
    });
  });
});
