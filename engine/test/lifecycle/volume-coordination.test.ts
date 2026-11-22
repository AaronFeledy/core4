import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, type VolumeRef } from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  RuntimeProviderRegistry,
  StateStore,
  type StateStoreShape,
  physicalVolumeLockKey,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as StateStoreLayer from "@lando/state-store/service";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Result } from "effect";
import { applyActivation } from "../../src/lifecycle/activation-apply.ts";
import { prepareServiceCertificates } from "../../src/lifecycle/service-certificates.ts";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../../src/lifecycle/volume-coordination.ts";
import { prepareProvider } from "../../src/providers/prepared.ts";
import { session, unusedResolver } from "./activation-apply-support.ts";

const coordinationKey = (name: string) => JSON.stringify(["endpoint:test", name]);
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
  source: "volume-coordination.test",
  runtime: 4 as const,
};
const plan = {
  id: AppId.make("app"),
  name: "App",
  slug: "app",
  root: AbsolutePath.make("/apps/app"),
  identity: { appRoot: AbsolutePath.make("/apps/app"), ownerKey: "owner" },
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  stores: [
    { name: "zeta", scope: "app", kind: "data" },
    { name: "alpha", scope: "app", kind: "data" },
    { name: "alias", scope: "global", kind: "cache", key: "npm" },
  ],
  fileSync: [],
  metadata,
  extensions: {},
} satisfies AppPlan;

let root = "";
let previousUserDataRoot: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-volume-coordination-"));
  previousUserDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = root;
});

afterEach(async () => {
  if (previousUserDataRoot === undefined) process.env.LANDO_USER_DATA_ROOT = undefined;
  else process.env.LANDO_USER_DATA_ROOT = previousUserDataRoot;
  await rm(root, { recursive: true, force: true });
});

const liveStore = (): Promise<StateStoreShape> =>
  Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLayer.layer)));

describe("physical volume lifecycle coordination", () => {
  test("cold-cache launches overlap before apply and serialize only their applies", async () => {
    const store = await liveStore();
    const nativeName = "lando-cache-composer";
    const key = coordinationKey(nativeName);
    const cache = { name: nativeName, kind: "cache", scope: "global" } as const;
    const first = { ...plan, stores: [cache] };
    const second = { ...first, id: AppId.make("second"), root: AbsolutePath.make("/apps/second") };
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstPrepared = yield* Deferred.make<void>();
        const secondPrepared = yield* Deferred.make<void>();
        const firstApplying = yield* Deferred.make<void>();
        const secondApplying = yield* Deferred.make<void>();
        const secondWaiting = yield* Deferred.make<void>();
        const finishFirstApply = yield* Deferred.make<void>();
        const finishFirstLaunch = yield* Deferred.make<void>();
        let presence: "absent" | "present" = "absent";
        const modes: Array<string | undefined> = [];
        const stateStore: StateStoreShape = {
          ...store,
          withLock: (lockKey, body, options) =>
            Effect.gen(function* () {
              if (lockKey === physicalVolumeLockKey(key)) {
                modes.push(options?.mode);
                if (modes.length === 2) yield* Deferred.succeed(secondWaiting, undefined);
              }
              return yield* store.withLock(lockKey, body, options);
            }),
        };
        const provider = yield* prepareProvider({
          ...TestRuntimeProvider,
          capabilities: { ...TestRuntimeProvider.capabilities, serializesVolumeCopyUp: true },
          locateVolume: ({ store }) =>
            Effect.sync(() => ({
              nativeName: store,
              coordinationKey: coordinationKey(store),
              presence,
            })),
          apply: (applied) =>
            Effect.gen(function* () {
              if (applied.id === first.id) {
                yield* Deferred.succeed(firstApplying, undefined);
                yield* Deferred.await(finishFirstApply);
                presence = "present";
              } else {
                yield* Deferred.succeed(secondApplying, undefined);
              }
              return { changed: true };
            }),
        });
        const launch = (
          plan: AppPlan,
          prepared: Deferred.Deferred<void>,
          otherPrepared: Deferred.Deferred<void>,
          gate: Effect.Effect<void>,
        ) =>
          withPlanVolumeCoordination({
            plan,
            provider,
            stateStore,
            body: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(prepared, undefined);
                yield* Deferred.await(otherPrepared);
                yield* gate;
                const { certificates } = yield* prepareServiceCertificates(plan);
                yield* applyActivation({
                  plan,
                  provider,
                  certificates,
                  reconcile: false,
                  environment: session,
                });
                if (plan.id === first.id) yield* Deferred.await(finishFirstLaunch);
              }),
          }).pipe(
            Effect.provideService(StateStore, stateStore),
            Effect.provideService(EnvironmentValueResolver, unusedResolver),
          );
        const left = yield* Effect.forkChild(launch(first, firstPrepared, secondPrepared, Effect.void));
        const right = yield* Effect.forkChild(
          launch(second, secondPrepared, firstPrepared, Deferred.await(firstApplying)),
        );
        yield* Deferred.await(secondWaiting);
        expect((yield* Deferred.poll(secondApplying))._tag).toBe("None");
        yield* Deferred.succeed(finishFirstApply, undefined);
        yield* Fiber.join(right);
        expect(modes).toEqual(["exclusive", "exclusive", "shared"]);
        yield* Deferred.succeed(finishFirstLaunch, undefined);
        yield* Fiber.join(left);
      }).pipe(Effect.timeout("3 seconds")),
    );
  });

  test("admission coordinates renamed data stores but does not locate global caches", async () => {
    const refs: VolumeRef[] = [];
    const renamed = { ...plan, identity: { ...plan.identity, dataName: "original" } };
    await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: renamed,
        stateStore: await liveStore(),
        provider: {
          id: "test",
          locateVolume: (ref) =>
            Effect.sync(() => {
              refs.push(ref);
              return { coordinationKey: coordinationKey(ref.store), nativeName: ref.store };
            }),
        },
        body: (coordination) => coordination.verify,
      }),
    );
    expect([...new Set(refs.map((ref) => ref.app))]).toEqual([AppId.make("original")]);
    expect([...new Set(refs.map((ref) => ref.store))].sort()).toEqual(["alpha", "zeta"]);
  });
  test.each([0, 1, 2])("preserves provider failure on observation %i", async (failureAt) => {
    // Given a provider that becomes unavailable during locate, lock verification, or body verification.
    const store = await liveStore();
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "ensureRuntime",
      message: "Managed runtime is unavailable",
      remediation: "Run lando setup",
    });
    let calls = 0;
    const provider = {
      id: "lando",
      locateVolume: () =>
        Effect.suspend(() =>
          calls++ === failureAt
            ? Effect.fail(failure)
            : Effect.succeed({ coordinationKey: "native", nativeName: "data" }),
        ),
    };
    // When coordination reaches that observation.
    const result = await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: { ...plan, stores: plan.stores.slice(0, 1) },
        provider,
        stateStore: store,
        body: (coordination) => coordination.verify,
      }).pipe(Effect.result),
    );
    // Then the original tag, message, and remediation survive unchanged.
    if (result._tag !== "Failure") throw new TypeError("expected provider failure");
    expect(result.failure).toBe(failure);
  });

  test("names the owning folder and recovery choices when another app owns a volume", async () => {
    // Given a store whose physical volume belongs to a different app root.
    const store = await liveStore();
    let mutated = false;
    const ownerRoot = AbsolutePath.make("/apps/old-app");
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({
          coordinationKey: coordinationKey(ref.store),
          nativeName: `app_${ref.store}`,
          identity: {
            coordinationKey: coordinationKey(ref.store),
            nativeName: `app_${ref.store}`,
            generation: "one",
            ownerRoot,
            origin: "created" as const,
          },
        }),
    };

    // When lifecycle coordination observes that owner.
    const result = await Effect.runPromise(
      withPlanVolumeCoordination({
        plan,
        provider,
        stateStore: store,
        body: () =>
          Effect.sync(() => {
            mutated = true;
          }),
      }).pipe(Effect.result),
    );

    // Then it refuses mutation with the store, both roots, and actionable recovery.
    expect(mutated).toBe(false);
    if (result._tag !== "Failure") throw new TypeError("expected ownership refusal");
    expect(result.failure).toMatchObject({ _tag: "VolumeOperationError", store: "zeta" });
    expect(result.failure.message).toContain("app_zeta (store zeta)");
    expect(result.failure.message).toContain(ownerRoot);
    expect(result.failure.message).toContain(plan.root);
    expect(result.failure.remediation).toContain(`lando destroy --root ${ownerRoot} --volumes`);
    expect(result.failure.remediation).toContain("name:");
    expect(result.failure.remediation).toContain("lando doctor");
  });

  test.each([false, true])(
    "startup accepts an unlabeled volume only with its inventory member (%s)",
    async (recorded) => {
      const scoped: AppPlan = {
        ...plan,
        identity: { ...plan.identity, dataRoot: AbsolutePath.make(root) },
        stores: [{ name: "zeta", scope: "app", kind: "data" }],
      };
      const nativeName = "app_zeta";
      const locator = {
        coordinationKey: coordinationKey(nativeName),
        nativeName,
        presence: "present",
        identity: {
          coordinationKey: coordinationKey(nativeName),
          nativeName,
          generation: "one",
          ownerRoot: plan.root,
          origin: "created",
        },
      } as const;
      const stateStore = await liveStore();
      const result = await Effect.runPromise(
        withPlanVolumeCoordination({
          plan: scoped,
          provider: { id: plan.provider, locateVolume: () => Effect.succeed(locator) },
          stateStore,
          body: () => Effect.succeed("admitted"),
        }).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            list: Effect.succeed([plan.provider]),
            capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
            select: () => Effect.succeed(TestRuntimeProvider),
            appliedPlansFor: () => Effect.succeed([]),
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.die("unexpected teardown"),
            resourceOwnership: () =>
              Effect.succeed({
                appRoot: plan.root,
                ownerKey: plan.identity.ownerKey,
                providerId: plan.provider,
                appIds: [plan.id],
                members: [
                  { kind: "volume", nativeName: recorded ? nativeName : "another-volume", appId: plan.id },
                ],
              }),
          }),
          Effect.result,
        ),
      );
      expect(result).toMatchObject(
        recorded
          ? { _tag: "Success", success: "admitted" }
          : { _tag: "Failure", failure: { _tag: "VolumeOperationError", store: "zeta" } },
      );
    },
  );

  test("sorts and deduplicates provider locators before acquiring advisory locks", async () => {
    // Given three plan stores where two provider locators identify one physical volume.
    const live = await liveStore();
    const acquired: string[] = [];
    const store: StateStoreShape = {
      ...live,
      withLock: (key, body, options) =>
        live.withLock(key, Effect.sync(() => acquired.push(key)).pipe(Effect.andThen(body)), options),
    };
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({
          coordinationKey: coordinationKey(ref.store === "alias" ? "alpha" : ref.store),
          nativeName: ref.store === "alias" ? "alpha" : ref.store,
        }),
    };

    // When the lifecycle body coordinates every declared store.
    await Effect.runPromise(
      withPlanVolumeCoordination({ plan, provider, stateStore: store, body: () => Effect.void }),
    );

    // Then each physical key is acquired once in stable lexical order.
    expect(acquired).toEqual(
      [coordinationKey("alpha"), coordinationKey("zeta")].sort().map(physicalVolumeLockKey),
    );
  });

  test("serializes a SQL writer and lifecycle mutation on the same physical key", async () => {
    // Given SQL holds the real advisory lock used by the lifecycle coordinator.
    const store = await liveStore();
    const sqlEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseSql = await Effect.runPromise(Deferred.make<void>());
    const lifecycleEntered = await Effect.runPromise(Deferred.make<void>());
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const sql = Effect.runFork(
      store.withLock(
        physicalVolumeLockKey(coordinationKey("alpha")),
        Deferred.succeed(sqlEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseSql))),
      ),
    );
    await Effect.runPromise(Deferred.await(sqlEntered));
    const sharedStore = plan.stores[1];
    if (sharedStore === undefined) throw new TypeError("expected shared store fixture");

    // When lifecycle coordination targets the same provider locator.
    const lifecycle = Effect.runFork(
      withPlanVolumeCoordination({
        plan: { ...plan, stores: [sharedStore] },
        provider,
        stateStore: store,
        body: () => Deferred.succeed(lifecycleEntered, undefined),
      }),
    );
    const beforeRelease = await Effect.runPromise(Deferred.poll(lifecycleEntered));
    await Effect.runPromise(Deferred.succeed(releaseSql, undefined));
    await Effect.runPromise(Fiber.join(sql));
    await Effect.runPromise(Fiber.join(lifecycle));

    // Then lifecycle cannot enter until SQL releases the shared primitive.
    expect(beforeRelease._tag).toBe("None");
    expect((await Effect.runPromise(Deferred.poll(lifecycleEntered)))._tag).toBe("Some");
  });

  test("rebinds to a post-lock observation when generation changes while waiting", async () => {
    // Given the first observation names generation one while another writer holds its lock.
    const store = await liveStore();
    const lockEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseLock = await Effect.runPromise(Deferred.make<void>());
    let generation = "one";
    let boundGeneration: string | undefined;
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({
          coordinationKey: coordinationKey(ref.store),
          nativeName: ref.store,
          presence: "present" as const,
          identity: {
            coordinationKey: coordinationKey(ref.store),
            nativeName: ref.store,
            generation,
            ownerRoot: plan.root,
            origin: "created" as const,
          },
        }),
    };
    const blocker = Effect.runFork(
      store.withLock(
        physicalVolumeLockKey(coordinationKey("alpha")),
        Deferred.succeed(lockEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseLock))),
      ),
    );
    await Effect.runPromise(Deferred.await(lockEntered));
    const sharedStore = plan.stores[1];
    if (sharedStore === undefined) throw new TypeError("expected shared store fixture");

    // When the volume is replaced before lifecycle acquires the same lock.
    const lifecycle = Effect.runFork(
      withPlanVolumeCoordination({
        plan: { ...plan, stores: [sharedStore] },
        provider,
        stateStore: store,
        body: (coordination) =>
          Effect.sync(() => {
            boundGeneration = coordination.locators[0]?.identity?.generation;
          }),
      }),
    );
    generation = "two";
    await Effect.runPromise(Deferred.succeed(releaseLock, undefined));
    await Effect.runPromise(Fiber.join(blocker));
    await Effect.runPromise(Fiber.join(lifecycle));

    // Then coordination binds the post-lock observation instead of failing the pre-lock snapshot.
    expect(boundGeneration).toBe("two");
  });

  test("allows a nested lifecycle phase to reuse locks already held by its fiber", async () => {
    const store = await liveStore();
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const sharedStore = plan.stores[1];
    if (sharedStore === undefined) throw new TypeError("expected shared store fixture");
    const sharedPlan = { ...plan, stores: [sharedStore] };

    const completed = await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: sharedPlan,
        provider,
        stateStore: store,
        body: () =>
          withPlanVolumeCoordination({
            plan: sharedPlan,
            provider,
            stateStore: store,
            body: () => Effect.succeed("nested"),
          }),
      }).pipe(Effect.timeout("1 second")),
    );

    expect(completed).toBe("nested");
  });

  test("a nested phase whose plan adds volumes locks only the keys its fiber does not hold", async () => {
    // Given an outer phase holding one store and a nested phase whose plan also names a second store,
    // like a rebuild's halt tearing down an applied plan that still has a removed service's volumes.
    const store = await liveStore();
    const locked: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (key, body, options) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body, options);
        }),
    };
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const [zeta, alpha] = plan.stores;
    if (zeta === undefined || alpha === undefined) throw new TypeError("expected store fixtures");

    // When
    const completed = await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: { ...plan, stores: [alpha] },
        provider,
        stateStore: recordingStore,
        body: () =>
          withPlanVolumeCoordination({
            plan: { ...plan, stores: [alpha, zeta] },
            provider,
            stateStore: recordingStore,
            body: (coordination) => coordination.verify.pipe(Effect.as("nested")),
          }),
      }).pipe(Effect.timeout("1 second")),
    );

    // Then
    expect(completed).toBe("nested");
    expect(locked).toEqual([
      physicalVolumeLockKey(coordinationKey("alpha")),
      physicalVolumeLockKey(coordinationKey("zeta")),
    ]);
  });

  test("locks the union of a plan and its additional plans once in sorted order", async () => {
    // Given a desired plan with one store and an applied plan that also names a removed service's store.
    const store = await liveStore();
    const locked: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (key, body, options) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body, options);
        }),
    };
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const [zeta, alpha] = plan.stores;
    if (zeta === undefined || alpha === undefined) throw new TypeError("expected store fixtures");
    const desired = { ...plan, stores: [zeta] };
    const applied = { ...plan, id: AppId.make("applied"), stores: [alpha, zeta] };
    const observed: string[] = [];
    const observer = {
      ...provider,
      locateVolume: (ref: { readonly store: string }) =>
        Effect.sync(() => observed.push(ref.store)).pipe(Effect.andThen(provider.locateVolume(ref))),
    };

    // When coordination covers the desired and applied plans as one union.
    const result = await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: desired,
        additionalPlans: [applied],
        provider,
        stateStore: recordingStore,
        body: () => verifyActiveVolumeCoordination(observer).pipe(Effect.as("union")),
      }).pipe(Effect.timeout("1 second")),
    );

    // Then each physical key is acquired once in sorted order and the body verifies the union.
    expect(result).toBe("union");
    expect(locked).toEqual([
      physicalVolumeLockKey(coordinationKey("alpha")),
      physicalVolumeLockKey(coordinationKey("zeta")),
    ]);
    expect(observed).toEqual(["alpha", "zeta"]);
  });

  test("a nested phase covered by the union short-circuits and keeps the union bindings", async () => {
    // Given a captured context from before coordination and an outer union of desired and applied plans.
    const store = await liveStore();
    const locked: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (key, body, options) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body, options);
        }),
    };
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const [zeta, alpha] = plan.stores;
    if (zeta === undefined || alpha === undefined) throw new TypeError("expected store fixtures");
    const desired = { ...plan, stores: [zeta] };
    const applied = { ...plan, id: AppId.make("applied"), stores: [alpha, zeta] };
    const observed: string[] = [];
    const observer = {
      ...provider,
      locateVolume: (ref: { readonly store: string }) =>
        Effect.sync(() => observed.push(ref.store)).pipe(Effect.andThen(provider.locateVolume(ref))),
    };

    // When the halt-style nested phase runs inside the stale context it captured before coordination.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Effect.context<never>();
        yield* withPlanVolumeCoordination({
          plan: desired,
          additionalPlans: [applied],
          provider,
          stateStore: recordingStore,
          body: () =>
            withPlanVolumeCoordination({
              plan: applied,
              provider,
              stateStore: recordingStore,
              body: () => verifyActiveVolumeCoordination(observer).pipe(Effect.as("nested")),
            }).pipe(Effect.provide(captured)),
        }).pipe(Effect.provide(captured));
        return observed;
      }).pipe(Effect.timeout("1 second")),
    );

    // Then no key is reacquired and verification inside the nested body still sees both plans' volumes.
    expect(result).toEqual(["alpha", "zeta"]);
    expect(locked).toEqual([
      physicalVolumeLockKey(coordinationKey("alpha")),
      physicalVolumeLockKey(coordinationKey("zeta")),
    ]);
  });

  test("rejects a nested expansion that sorts below a key its fiber already holds", async () => {
    // Given an outer phase holding the higher-sorted key.
    const store = await liveStore();
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const [zeta, alpha] = plan.stores;
    if (zeta === undefined || alpha === undefined) throw new TypeError("expected store fixtures");

    // When a nested phase needs the lower-sorted key, which would invert the global lock order.
    const result = await Effect.runPromiseExit(
      withPlanVolumeCoordination({
        plan: { ...plan, stores: [zeta] },
        provider,
        stateStore: store,
        body: () =>
          withPlanVolumeCoordination({
            plan: { ...plan, stores: [alpha] },
            provider,
            stateStore: store,
            body: () => Effect.succeed("unreachable"),
          }),
      }).pipe(Effect.timeout("1 second")),
    );

    // Then it dies promptly, names both keys, and calls out the Lando bug instead of deadlocking.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) {
        expect(String(defect.success)).toContain(coordinationKey("alpha"));
        expect(String(defect.success)).toContain(coordinationKey("zeta"));
        expect(String(defect.success)).toContain("Lando bug");
      }
    }
  });

  test("a context captured inside a phase never hides a nested expansion's bindings", async () => {
    // Given an outer phase holding alpha and a nested phase that adds the higher-sorted zeta.
    const store = await liveStore();
    const locked: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (key, body, options) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body, options);
        }),
    };
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({ coordinationKey: coordinationKey(ref.store), nativeName: ref.store }),
    };
    const [zeta, alpha] = plan.stores;
    if (zeta === undefined || alpha === undefined) throw new TypeError("expected store fixtures");
    const observed: string[] = [];
    const observer = {
      ...provider,
      locateVolume: (ref: { readonly store: string }) =>
        Effect.sync(() => observed.push(ref.store)).pipe(Effect.andThen(provider.locateVolume(ref))),
    };

    // When the nested phase runs inside the context it captured from the outer body.
    const result = await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: { ...plan, stores: [alpha] },
        provider,
        stateStore: recordingStore,
        body: Effect.fnUntraced(function* () {
          const captured = yield* Effect.context<never>();
          return yield* withPlanVolumeCoordination({
            plan: { ...plan, stores: [alpha, zeta] },
            provider,
            stateStore: recordingStore,
            body: () => verifyActiveVolumeCoordination(observer).pipe(Effect.as("nested")),
          }).pipe(Effect.provide(captured));
        }),
      }).pipe(Effect.timeout("1 second")),
    );

    // Then the nested bindings win over the stale captured context and both locks stay ordered.
    expect(result).toBe("nested");
    expect(observed).toEqual(["alpha", "zeta"]);
    expect(locked).toEqual([
      physicalVolumeLockKey(coordinationKey("alpha")),
      physicalVolumeLockKey(coordinationKey("zeta")),
    ]);
  });

  test("two present global-cache activations take shared locks and cross a barrier concurrently", async () => {
    // Given two plans that share one present global cache volume on a real disk StateStore.
    const store = await liveStore();
    const modes: Array<string | undefined> = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (key, body, options) =>
        Effect.suspend(() => {
          modes.push(options?.mode);
          return store.withLock(key, body, options);
        }),
    };
    const cache = { name: "composer", scope: "global" as const, kind: "cache" as const, key: "composer" };
    const cachePlan = { ...plan, stores: [cache] };
    const otherPlan = { ...cachePlan, id: AppId.make("other"), root: AbsolutePath.make("/apps/other") };
    const locator = {
      coordinationKey: coordinationKey("composer"),
      nativeName: "lando-cache-composer",
      presence: "present" as const,
      identity: {
        coordinationKey: coordinationKey("composer"),
        nativeName: "lando-cache-composer",
        generation: "gen-1",
        ownerRoot: AbsolutePath.make("/global"),
        origin: "created" as const,
      },
    };
    const provider = {
      id: "test",
      locateVolume: () => Effect.succeed(locator),
      capabilities: { serializesVolumeCopyUp: true },
    };
    const leftReady = await Effect.runPromise(Deferred.make<void>());
    const rightReady = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());

    // When both activations hold the shared cache and wait at a barrier.
    const left = Effect.runFork(
      withPlanVolumeCoordination({
        plan: cachePlan,
        cachePolicy: "apply",
        provider,
        stateStore: recordingStore,
        body: () =>
          Deferred.succeed(leftReady, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("left"),
          ),
      }),
    );
    const right = Effect.runFork(
      withPlanVolumeCoordination({
        plan: otherPlan,
        cachePolicy: "apply",
        provider,
        stateStore: recordingStore,
        body: () =>
          Deferred.succeed(rightReady, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("right"),
          ),
      }),
    );
    await Effect.runPromise(Deferred.await(leftReady).pipe(Effect.timeout("2 seconds")));
    await Effect.runPromise(Deferred.await(rightReady).pipe(Effect.timeout("2 seconds")));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    const results = await Effect.runPromise(
      Effect.all([Fiber.join(left), Fiber.join(right)]).pipe(Effect.timeout("2 seconds")),
    );

    // Then both crossed the checkpoint together under shared mode.
    expect(results).toEqual(["left", "right"]);
    expect(modes).toEqual(["shared", "shared"]);
  });

  test("an absent global cache takes exclusive and rebinds when it appears while waiting", async () => {
    // Given cold-create observation (absent) while another writer holds the physical key.
    const store = await liveStore();
    const modes: Array<string | undefined> = [];
    const attempted = await Effect.runPromise(Deferred.make<void>());
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (key, body, options) =>
        Effect.suspend(() => {
          modes.push(options?.mode);
          return Deferred.succeed(attempted, undefined).pipe(
            Effect.andThen(store.withLock(key, body, options)),
          );
        }),
    };
    const cache = { name: "composer", scope: "global" as const, kind: "cache" as const, key: "composer" };
    const cachePlan = { ...plan, stores: [cache] };
    const key = coordinationKey("composer");
    let presence: "absent" | "present" = "absent";
    const provider = {
      id: "test",
      capabilities: { serializesVolumeCopyUp: true },
      locateVolume: () =>
        Effect.succeed(
          presence === "absent"
            ? {
                coordinationKey: key,
                nativeName: "lando-cache-composer",
                presence: "absent" as const,
              }
            : {
                coordinationKey: key,
                nativeName: "lando-cache-composer",
                presence: "present" as const,
                identity: {
                  coordinationKey: key,
                  nativeName: "lando-cache-composer",
                  generation: "created-1",
                  ownerRoot: AbsolutePath.make("/global"),
                  origin: "created" as const,
                },
              },
        ),
    };
    const lockEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseLock = await Effect.runPromise(Deferred.make<void>());
    const blocker = Effect.runFork(
      store.withLock(
        physicalVolumeLockKey(key),
        Deferred.succeed(lockEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseLock))),
        { mode: "exclusive", wait: "operation" },
      ),
    );
    await Effect.runPromise(Deferred.await(lockEntered));
    let boundPresence: string | undefined;
    let boundGeneration: string | undefined;

    // When cold create waits, the volume appears, then the exclusive holder releases.
    const lifecycle = Effect.runFork(
      withPlanVolumeCoordination({
        plan: cachePlan,
        cachePolicy: "apply",
        provider,
        stateStore: recordingStore,
        body: (coordination) =>
          Effect.sync(() => {
            boundPresence = coordination.locators[0]?.presence;
            boundGeneration = coordination.locators[0]?.identity?.generation;
          }),
      }),
    );
    await Effect.runPromise(Deferred.await(attempted).pipe(Effect.timeout("2 seconds")));
    presence = "present";
    await Effect.runPromise(Deferred.succeed(releaseLock, undefined));
    await Effect.runPromise(Fiber.join(blocker));
    await Effect.runPromise(Fiber.join(lifecycle).pipe(Effect.timeout("2 seconds")));

    // Then acquisition was exclusive for the absent observation and the body sees the post-lock volume.
    expect(modes).toEqual(["exclusive", "shared"]);
    expect(boundPresence).toBe("present");
    expect(boundGeneration).toBe("created-1");
  });

  test("exclusive purge waits behind shared present-cache holders", async () => {
    // Given a shared holder already inside a present global-cache activation.
    const store = await liveStore();
    const cache = { name: "composer", scope: "global" as const, kind: "cache" as const, key: "composer" };
    const cachePlan = { ...plan, stores: [cache] };
    const locator = {
      coordinationKey: coordinationKey("composer"),
      nativeName: "lando-cache-composer",
      presence: "present" as const,
      identity: {
        coordinationKey: coordinationKey("composer"),
        nativeName: "lando-cache-composer",
        generation: "gen-1",
        ownerRoot: AbsolutePath.make("/global"),
        origin: "created" as const,
      },
    };
    const provider = {
      id: "test",
      locateVolume: () => Effect.succeed(locator),
      capabilities: { serializesVolumeCopyUp: true },
    };
    const sharedEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseShared = await Effect.runPromise(Deferred.make<void>());
    const exclusiveEntered = await Effect.runPromise(Deferred.make<void>());
    const shared = Effect.runFork(
      withPlanVolumeCoordination({
        plan: cachePlan,
        cachePolicy: "apply",
        provider,
        stateStore: store,
        body: () =>
          Deferred.succeed(sharedEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseShared))),
      }),
    );
    await Effect.runPromise(Deferred.await(sharedEntered));

    // When a purge-style exclusive coordination targets the same physical key.
    const exclusive = Effect.runFork(
      withPlanVolumeCoordination({
        plan: cachePlan,
        provider,
        stateStore: store,
        cachePolicy: "purge",
        body: () => Deferred.succeed(exclusiveEntered, undefined),
      }),
    );
    const beforeRelease = await Effect.runPromise(Deferred.poll(exclusiveEntered));
    await Effect.runPromise(Deferred.succeed(releaseShared, undefined));
    await Effect.runPromise(Fiber.join(shared));
    await Effect.runPromise(Fiber.join(exclusive).pipe(Effect.timeout("2 seconds")));

    // Then exclusive could not enter until every shared holder released.
    expect(beforeRelease._tag).toBe("None");
    expect((await Effect.runPromise(Deferred.poll(exclusiveEntered)))._tag).toBe("Some");
  });

  test.each([undefined, false])(
    "warm apply takes exclusive when copy-up serialization is %s",
    async (capability) => {
      const store = await liveStore();
      const modes: Array<string | undefined> = [];
      await Effect.runPromise(
        withPlanVolumeCoordination({
          plan: { ...plan, stores: [{ name: "lando-cache-composer", kind: "cache", scope: "global" }] },
          provider: {
            id: "docker",
            ...(capability === undefined ? {} : { capabilities: { serializesVolumeCopyUp: capability } }),
            locateVolume: ({ store }) =>
              Effect.succeed({
                nativeName: store,
                coordinationKey: coordinationKey(store),
                presence: "present",
              }),
          },
          stateStore: {
            ...store,
            withLock: (key, body, options) =>
              Effect.suspend(() => {
                modes.push(options?.mode);
                return store.withLock(key, body, options);
              }),
          },
          cachePolicy: "apply",
          body: () => Effect.void,
        }),
      );
      expect(modes).toEqual(["exclusive"]);
    },
  );
});
