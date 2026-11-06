import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  DataTransferError,
  EventError,
  ProviderUnavailableError,
  ProxyError,
  ScratchAppError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  LandofileShape,
  ProviderId,
  type SnapshotInfo,
  planAppIdentity,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  DataMover,
  EventService,
  type LandoEvent,
  LandofileService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  ScratchAppService,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect, Layer, Predicate, Schema, Stream } from "effect";
import {
  ScratchRegistry,
  type ScratchRegistryEntry,
  planScratchRegistryWrite,
} from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import * as Scratch from "../../src/scratch-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

export const seedScratchPlan = (instanceRoot: string, plan: AppPlan): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = makeStateStore({ privateFileAccess: ownerOnlyFileAccess });
      const bucket = yield* store.open({
        root: { path: AbsolutePath.make(instanceRoot) },
        key: "plan.bin",
        schema: AppPlan,
        version: 1,
        codec: "binary",
        mode: 0o600,
        onCorrupt: "quarantine",
        onVersionMismatch: "discard",
      });
      yield* bucket.set(plan);
    }),
  );

interface DestroyFixtureOptions {
  readonly orphan?: boolean;
  readonly cwd?: boolean;
  readonly fail?: boolean;
  readonly routeFail?: boolean;
  readonly copyFail?: boolean;
  readonly registryFail?: boolean;
  readonly postScratchDestroyFail?: boolean;
}

export const withDestroyFixture = async (
  options: DestroyFixtureOptions,
  use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
) => {
  const base = await mkdtemp(join(tmpdir(), "scratch-destroy-"));
  const root = join(base, "data");
  const cacheRoot = join(base, "cache");
  await mkdir(root, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_DATA_ROOT = root;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  try {
    await use(await makeFixture(root, options));
  } finally {
    if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    if (previousCache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCache;
    await rm(base, { recursive: true, force: true });
  }
};

const makeFixture = async (root: string, options: DestroyFixtureOptions) => {
  const id = AppId.make("scratch-demo-123456");
  const instanceRoot = AbsolutePath.make(join(root, "scratch", id));
  const planRoot = AbsolutePath.make(options.cwd ? join(root, "source-app") : join(instanceRoot, "root"));
  const plan: AppPlan = {
    id,
    name: id,
    slug: id,
    provider: ProviderId.make("lando"),
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    metadata: {
      resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
      source: "scratch",
      runtime: 4,
    },
    extensions: {},
    root: planRoot,
    identity: planAppIdentity({ root: planRoot }),
  };
  const calls: string[] = [];
  const events: LandoEvent[] = [];
  const rootObservations: { readonly tag: string; readonly exists: boolean }[] = [];
  const snapshots: SnapshotInfo[] = [id, AppId.make("user-app")].map((app) => ({
    owner: planAppIdentity(plan),
    id: `${app}-snapshot`,
    store: { app, store: "data" },
    digest: "digest",
    sizeBytes: 1,
    createdAt: DateTime.makeUnsafe(0),
  }));
  const removed: string[] = [];
  const entries = new Map<string, ScratchRegistryEntry>();
  const entry: ScratchRegistryEntry = {
    id,
    rootPath: planRoot,
    source: { kind: "fork" },
    isolate: options.cwd ? "cwd" : "full",
    detached: false,
    ownerPid: 999999999,
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  if (!options.orphan) entries.set(id, entry);
  await mkdir(join(instanceRoot, "root"), { recursive: true });
  if (!options.orphan) await seedScratchPlan(instanceRoot, plan);
  const stateStore = makeStateStore({ privateFileAccess: ownerOnlyFileAccess });
  const provider = {
    ...TestRuntimeProvider,
    destroy: (_target: unknown, request: { readonly volumes: boolean; readonly removeState?: boolean }) =>
      Effect.sync(() => {
        calls.push(request.removeState ? `destroy:${request.volumes}` : "stop");
        return { kind: "destroyed" as const };
      }).pipe(
        Effect.flatMap((outcome) =>
          options.fail && request.removeState
            ? Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "destroy",
                  message: "injected",
                  remediation: "Install or start the `lando` provider and confirm it can perform `destroy`.",
                }),
              )
            : Effect.succeed(outcome),
        ),
      ),
  };
  const providers = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const dependencies = Layer.mergeAll(
    testEnvironmentResolverLayer,
    FileSystem.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(StateStore, stateStore),
    providers,
    ScratchResourceScanner.layer.pipe(Layer.provide(providers)),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({ plan: () => Effect.succeed({ ...plan, valueModel: 1 as const }) }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalTestLandofile(
            Schema.decodeUnknownSync(LandofileShape)({ name: "demo", runtime: 4, services: {} }),
          ),
        ),
      }),
    ),
    Layer.succeed(
      Scratch.ScratchInitAppPort,
      Scratch.ScratchInitAppPort.of({ initApp: () => Promise.reject(new TypeError("unused recipe")) }),
    ),
    Layer.succeed(
      ScratchRegistry,
      ScratchRegistry.of({
        get: (key) => Effect.sync(() => entries.get(key)),
        list: () => Effect.sync(() => [...entries.values()]),
        read: () => Effect.sync(() => ({ version: 2, entries: [...entries.values()] })),
        upsert: (...write) =>
          Effect.sync(() => {
            calls.push("registry:upsert");
          }).pipe(
            Effect.andThen(() =>
              options.registryFail
                ? Effect.fail(
                    new ScratchAppError({
                      operation: "registry.write",
                      message: "injected write failure",
                      remediation: "Injected registry write failure for destroy fixture.",
                    }),
                  )
                : planScratchRegistryWrite(entries.get(write[1].id), ...write).pipe(
                    Effect.map((plan) => {
                      if (plan._tag === "Set") entries.set(plan.value.id, plan.value);
                    }),
                  ),
            ),
          ),
        remove: (key) =>
          Effect.sync(() => {
            calls.push("registry");
            entries.delete(key);
          }),
      }),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        removeRoutes: (_owner) =>
          Effect.sync(() => {
            calls.push("routes");
          }).pipe(
            Effect.andThen(
              options.routeFail
                ? Effect.fail(
                    new ProxyError({
                      proxyId: "test",
                      message: "route failure",
                      remediation:
                        "Install or repair the `test` router plugin and ensure `defaultRouterService` points at an installed id.",
                    }),
                  )
                : Effect.void,
            ),
          ),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          options.postScratchDestroyFail === true && event._tag === "post-scratch-destroy"
            ? Effect.fail(
                new EventError({
                  message: "injected post-scratch-destroy failure",
                  event: event._tag,
                  remediation: "Injected event failure for destroy fixture.",
                }),
              )
            : Effect.sync(() => {
                calls.push(event._tag);
                events.push(event);
                const app = Predicate.hasProperty(event, "app") ? event.app : undefined;
                if (
                  Predicate.hasProperty(app, "kind") &&
                  app.kind === "scratch" &&
                  Predicate.hasProperty(app, "root") &&
                  typeof app.root === "string"
                )
                  rootObservations.push({ tag: event._tag, exists: existsSync(app.root) });
              }),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.die("unused queue"),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
    Layer.succeed(
      DataMover,
      DataMover.of({
        transfer: () =>
          options.copyFail
            ? Effect.fail(
                new DataTransferError({
                  operation: "copy",
                  message: "injected copy failure",
                  remediation: "Injected copy failure for destroy fixture.",
                }),
              )
            : Effect.die("unused transfer"),
        transferStream: () => Stream.empty,
        read: () => Stream.empty,
        snapshot: () => Effect.die("unused snapshot"),
        restore: () => Effect.die("unused restore"),
        resolveSnapshot: () => Effect.die("unused resolve"),
        listSnapshots: (filter) =>
          Effect.sync(() => {
            calls.push("snapshots:list");
            return snapshots.filter((info) => info.owner.ownerKey === filter.ownerKey);
          }),
        removeSnapshot: (handle) =>
          Effect.sync(() => {
            calls.push("snapshot:remove");
            removed.push(handle.id);
          }),
        findOrphanedSnapshots: Effect.succeed([]),
        removeOrphanedSnapshot: () => Effect.void,
        pruneSnapshots: () => Effect.succeed([]),
      }),
    ),
  );
  return {
    id,
    entry,
    plan,
    instanceRoot,
    calls,
    events,
    rootObservations,
    removed,
    entries,
    layer: Scratch.layer.pipe(Layer.provideMerge(dependencies)),
  };
};

export const runDestroy = (fixture: Awaited<ReturnType<typeof makeFixture>>, keepVolumes = false) =>
  Effect.runPromise(
    Effect.flatMap(ScratchAppService, (scratch) => scratch.destroy(fixture.id, { keepVolumes })).pipe(
      Effect.provide(fixture.layer),
    ),
  );
import { literalTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
