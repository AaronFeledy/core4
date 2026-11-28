import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  DataTransferError,
  EventError,
  ProviderUnavailableError,
  ProxyError,
  ScratchAppError,
  appliedStateVersionError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  AppPlan,
  ProviderId,
  type ResourceOwnership,
  type SnapshotInfo,
  appIdentityKey,
  planAppIdentity,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  type BringDownOptions,
  DataMover,
  EventService,
  type LandoEvent,
  type OwnedResourcesCleanupOptions,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  ScratchAppService,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect, Layer, Predicate, Stream } from "effect";
import { RuntimeCwd } from "../../src/runtime/cwd.ts";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { SCRATCH_DESIRED_PLAN_VERSION } from "../../src/scratch-app/plan.ts";
import {
  SCRATCH_REGISTRY_VERSION,
  ScratchRegistry,
  type ScratchRegistryEntry,
  planScratchRegistryWrite,
} from "../../src/scratch-app/registry.ts";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import * as Scratch from "../../src/scratch-app/service.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

export const seedScratchPlan = (
  instanceRoot: string,
  plan: AppPlan,
  version: number = SCRATCH_DESIRED_PLAN_VERSION,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = makeStateStore({ privateFileAccess: ownerOnlyFileAccess });
      const bucket = yield* store.open({
        root: { path: AbsolutePath.make(instanceRoot) },
        key: "plan.bin",
        schema: AppPlan,
        version,
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
  /** `"once"` fails only the first route withdrawal, so a retry can succeed. */
  readonly routeFail?: boolean | "once";
  readonly copyFail?: boolean;
  readonly registryFail?: boolean;
  readonly postScratchDestroyFail?: boolean;
  /** When set, desired plan.bin is not seeded (cache miss). */
  readonly skipDesiredPlan?: boolean;
  /** Old desired-plan frame written instead of the current version. */
  readonly desiredPlanVersion?: number;
  /** Return the scratch app's applied plan from resolveAppliedPlan; defaults to none. */
  readonly appliedPlan?: true | "other-engine";
  /** A newer receipt protects this scratch app, by name or as the provider's shared record. */
  readonly offlineNewerReceipt?: "app" | "provider";
  /**
   * The scratch survives only as a provider ownership inventory under its managed root, beside a
   * source app's inventory that also records a scratch id.
   */
  readonly ownershipOnly?: boolean;
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
  let routeFailures =
    options.routeFail === "once" ? 1 : options.routeFail === true ? Number.POSITIVE_INFINITY : 0;
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
  const withdrawnOwnerKeys: string[] = [];
  const entries = new Map<string, ScratchRegistryEntry>();
  const entry: ScratchRegistryEntry = {
    id,
    rootPath: planRoot,
    source: { kind: "fork" },
    isolate: options.cwd ? "cwd" : "full",
    layout: options.cwd ? "legacy" : "managed",
    detached: false,
    ownerPid: 999999999,
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  if (!options.orphan && !options.ownershipOnly) entries.set(id, entry);
  if (!options.ownershipOnly) await mkdir(join(instanceRoot, "root"), { recursive: true });
  const managedRoot = AbsolutePath.make(join(await realpath(root), "scratch", id, "root"));
  const sourceRoot = AbsolutePath.make(join(root, "source-app"));
  if (options.copyFail) {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, ".lando.yml"), "name: demo\nruntime: 4\nservices: {}\n");
  }
  let ownership: ReadonlyArray<ResourceOwnership> = options.ownershipOnly
    ? [
        {
          appRoot: managedRoot,
          ownerKey: appIdentityKey("owner", managedRoot),
          providerId: ProviderId.make("lando"),
          appIds: [id],
        },
        {
          appRoot: sourceRoot,
          ownerKey: appIdentityKey("owner", sourceRoot),
          providerId: ProviderId.make("lando"),
          appIds: [AppId.make("scratch-legacy-654321")],
        },
      ]
    : [];
  if (!options.orphan && !options.ownershipOnly && options.skipDesiredPlan !== true)
    await seedScratchPlan(instanceRoot, plan, options.desiredPlanVersion ?? SCRATCH_DESIRED_PLAN_VERSION);
  const stateStore = makeStateStore({ privateFileAccess: ownerOnlyFileAccess });
  // A reap brings the scratch down three times: stop, destroy, then forget its applied receipt.
  let stopped = false;
  const provider = {
    ...TestRuntimeProvider,
    id: plan.provider,
    ...(options.appliedPlan === "other-engine"
      ? { engineIdentity: { fingerprint: "current", endpoint: "unix:///current.sock" } }
      : {}),
    ...(options.offlineNewerReceipt
      ? { isAvailable: Effect.succeed(false), getStatus: Effect.succeed({ state: "idle" as const }) }
      : {}),
    cleanupOwnedResources: (cleanupRoot: AbsolutePath, request: OwnedResourcesCleanupOptions) =>
      Effect.sync(() => {
        calls.push(`cleanup:${request.appIds?.join(",")}:releaseCaches=${request.releaseCaches}`);
        ownership = ownership.filter((hints) => hints.appRoot !== cleanupRoot);
        return { servicesRemoved: [], networksRemoved: 0, volumesRemoved: { data: 0, cache: 0 } };
      }),
    bringDown: (target: { readonly app: AppId }, request: BringDownOptions) =>
      Effect.sync(() => {
        const call = request.removeState ? "forget" : stopped ? `destroy:${request.volumes}` : "stop";
        stopped = true;
        calls.push(call);
        return call;
      }).pipe(
        Effect.flatMap((call) =>
          options.fail && call.startsWith("destroy:")
            ? Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "destroy",
                  message: "injected",
                  remediation: "Install or start the `lando` provider and confirm it can perform `destroy`.",
                }),
              )
            : Effect.sync(() => {
                if (call === "forget" && applied?.id === target.app) applied = undefined;
                return { kind: "removed" as const, containers: [], volumesRemoved: { data: 0, cache: 0 } };
              }),
        ),
      ),
  };
  // The applied receipt a forgetting bring-down removes.
  let applied = options.appliedPlan
    ? {
        ...plan,
        ...(options.appliedPlan === "other-engine"
          ? { engineIdentity: { fingerprint: "old", endpoint: "tcp://secret@old.example:2375" } }
          : {}),
        extensions: {
          [SCRATCH_EXTENSION_KEY]: options.cwd ? { id } : { id, projectRoot: planRoot },
        },
      }
    : undefined;
  const unreadable =
    options.offlineNewerReceipt === undefined
      ? []
      : [
          {
            ...(options.offlineNewerReceipt === "app" ? { appId: plan.id } : {}),
            path: join(root, "applied.json"),
            reason: "newer-version" as const,
            storedVersion: 11,
            supportedVersion: 10,
          },
        ];
  const providers = Layer.succeed(
    RuntimeProviderRegistry,
    makeTestRuntimeProviderRegistry({
      readAppliedPlanStrict: ({ id, provider }) => {
        const issue = unreadable.find(
          (entry) => (entry.appId === undefined || entry.appId === id) && provider === plan.provider,
        );
        return issue === undefined
          ? Effect.succeed(applied?.id === id && applied.provider === provider ? applied : undefined)
          : Effect.fail(
              appliedStateVersionError({
                ...issue,
                providerId: provider,
                operation: "applied-state.read",
                scope: issue.appId === undefined ? "provider" : "app",
              }),
            );
      },
      appliedStateInventory: (provider) =>
        Effect.succeed({ plans: [], unreadable: provider === plan.provider ? unreadable : [] }),
      appliedPlansFor: () => Effect.sync(() => (applied === undefined ? [] : [applied])),
      resolveAppliedPlan: () => Effect.sync(() => applied),
      resolveTeardownEvidence: (lookupRoot) =>
        Effect.sync(() => {
          if (applied !== undefined) return { kind: "applied" as const, plan: applied };
          const owned = ownership.filter((hints) => hints.appRoot === lookupRoot);
          return owned.length === 0
            ? { kind: "absent" as const }
            : { kind: "owned" as const, ownership: owned };
        }),
      listResourceOwnership: (provider) =>
        Effect.sync(() => ownership.filter((hints) => hints.providerId === provider)),
      list: Effect.succeed([ProviderId.make("docker"), ProviderId.make("lando"), ProviderId.make("podman")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
  const dependencies = Layer.mergeAll(
    PrivateFileAccessService.layer,
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
    Layer.succeed(RuntimeCwd, sourceRoot),
    Layer.succeed(
      Scratch.ScratchInitAppPort,
      Scratch.ScratchInitAppPort.of({ initApp: () => Promise.reject(new TypeError("unused recipe")) }),
    ),
    Layer.succeed(
      ScratchRegistry,
      ScratchRegistry.of({
        get: (key) => Effect.sync(() => entries.get(key)),
        list: () => Effect.sync(() => [...entries.values()]),
        read: () =>
          Effect.sync(() => ({ version: SCRATCH_REGISTRY_VERSION, entries: [...entries.values()] })),
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
                      return undefined;
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
        removeRoutes: (owner) =>
          Effect.sync(() => {
            calls.push("routes");
            withdrawnOwnerKeys.push(owner.ownerKey);
          }).pipe(
            Effect.andThen(
              routeFailures-- > 0
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
                if (event._tag === "pre-scratch-destroy") stopped = false;
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
    withdrawnOwnerKeys,
    events,
    rootObservations,
    removed,
    entries,
    stateStore,
    receipt: () => applied,
    layer: Scratch.layer.pipe(Layer.provideMerge(dependencies)),
  };
};

export const runDestroy = (fixture: Awaited<ReturnType<typeof makeFixture>>, keepVolumes = false) =>
  Effect.runPromise(
    Effect.flatMap(ScratchAppService, (scratch) => scratch.destroy(fixture.id, { keepVolumes })).pipe(
      Effect.provide(fixture.layer),
    ),
  );

import { testEnvironmentResolverLayer } from "../environment-values.ts";
