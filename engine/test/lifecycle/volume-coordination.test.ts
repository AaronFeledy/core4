import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Deferred, Effect, Exit, Fiber } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { StateStore, type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";

import { withPlanVolumeCoordination } from "../../src/lifecycle/volume-coordination.ts";

const coordinationKey = (name: string) => JSON.stringify(["endpoint:test", name]);
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-14T00:00:00Z"),
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
  networks: [],
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
  Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));

describe("physical volume lifecycle coordination", () => {
  test("sorts and deduplicates provider locators before acquiring advisory locks", async () => {
    // Given three plan stores where two provider locators identify one physical volume.
    const live = await liveStore();
    const acquired: string[] = [];
    const store: StateStoreShape = {
      ...live,
      withLock: (key, body) =>
        live.withLock(key, Effect.sync(() => acquired.push(key)).pipe(Effect.zipRight(body))),
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
        Deferred.succeed(sqlEntered, undefined).pipe(Effect.zipRight(Deferred.await(releaseSql))),
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
        Deferred.succeed(lockEntered, undefined).pipe(Effect.zipRight(Deferred.await(releaseLock))),
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
});
