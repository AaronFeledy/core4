import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, type VolumeRef } from "@lando/sdk/schema";
import { StateStore, type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Option, Result } from "effect";

import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
} from "../../src/lifecycle/volume-coordination.ts";

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
  test("coordinates renamed plan stores through their data id", async () => {
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
    expect([...new Set(refs.map((ref) => ref.store))].sort()).toEqual(["alias", "alpha", "zeta"]);
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

  test("sorts and deduplicates provider locators before acquiring advisory locks", async () => {
    // Given three plan stores where two provider locators identify one physical volume.
    const live = await liveStore();
    const acquired: string[] = [];
    const store: StateStoreShape = {
      ...live,
      withLock: (key, body) =>
        live.withLock(key, Effect.sync(() => acquired.push(key)).pipe(Effect.andThen(body))),
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

  test("rejects a replacement that occurs while waiting for the advisory lock", async () => {
    // Given the first observation names generation one while another writer holds its lock.
    const store = await liveStore();
    const lockEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseLock = await Effect.runPromise(Deferred.make<void>());
    let generation = "one";
    let mutated = false;
    const provider = {
      id: "test",
      locateVolume: (ref: { readonly store: string }) =>
        Effect.succeed({
          coordinationKey: coordinationKey(ref.store),
          nativeName: ref.store,
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
        body: () =>
          Effect.sync(() => {
            mutated = true;
          }),
      }),
    );
    generation = "two";
    await Effect.runPromise(Deferred.succeed(releaseLock, undefined));
    await Effect.runPromise(Fiber.join(blocker));
    const exit = await Effect.runPromise(Fiber.await(lifecycle));

    // Then the generation check fails before the lifecycle mutation runs.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isNone(failure)) throw new TypeError("expected typed identity-change failure");
      expect(failure.value).toMatchObject({
        remediation: "Retry after the concurrent volume operation completes, then inspect volume ownership.",
      });
    }
    expect(mutated).toBe(false);
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
      withLock: (key, body) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body);
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
      withLock: (key, body) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body);
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
      withLock: (key, body) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body);
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
      withLock: (key, body) =>
        Effect.suspend(() => {
          locked.push(key);
          return store.withLock(key, body);
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
});
