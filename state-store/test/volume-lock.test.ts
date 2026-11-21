import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { landoAppStoreName, landoCacheStoreName, landoServiceStoreName } from "@lando/sdk/schema";
import { StateStore, type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import * as StateStoreLayer from "../src/service.ts";
import { makeTestStateStore } from "../src/testing.ts";
import { withPhysicalVolumeLock, withPhysicalVolumeLocks } from "../src/volume-lock.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-volume-lock-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const liveStore = (): Promise<StateStoreShape> =>
  Effect.runPromise(
    StateStore.pipe(Effect.provide(StateStoreLayer.layerAt(makeLandoPaths({ userDataRoot: root }).roots))),
  );

const request = (key: string, name: string, mode?: "exclusive" | "shared") => ({
  key,
  name,
  ...(mode === undefined ? {} : { mode }),
});

describe("physical volume lock modes and union deadline", () => {
  test("exclusive request on a shared-held key is an upgrade defect", async () => {
    // Given this fiber already holds the coordination key shared.
    const store = await liveStore();
    const key = "endpoint:test/composer";
    const name = landoCacheStoreName("composer");

    // When nested work requests exclusive on the same key.
    const result = await Effect.runPromiseExit(
      withPhysicalVolumeLock(
        store,
        request(key, name, "shared"),
        withPhysicalVolumeLock(store, request(key, name, "exclusive"), Effect.succeed("unreachable")),
      ).pipe(Effect.timeout("1 second")),
    );

    // Then it dies promptly naming the upgrade refusal instead of waiting or upgrading.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) {
        expect(String(defect.success)).toContain(key);
        expect(String(defect.success)).toContain("upgrade");
      }
    }
  });

  test("a volume union times out on the second key at the original deadline", async () => {
    const { service: store } = makeTestStateStore();
    const first = request("endpoint:test/alpha", landoServiceStoreName("app", "alpha", "data"));
    const second = request("endpoint:test/zeta", landoServiceStoreName("app", "zeta", "data"));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const firstHeld = yield* Deferred.make<void>();
        const secondHeld = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstBlocker = yield* Effect.forkChild(
          store.withLock(
            physicalVolumeLockKey(first.key),
            Deferred.succeed(firstHeld, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
          ),
        );
        yield* Effect.forkChild(
          store.withLock(
            physicalVolumeLockKey(second.key),
            Deferred.succeed(secondHeld, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(firstHeld);
        yield* Deferred.await(secondHeld);

        const union = yield* Effect.forkChild(
          withPhysicalVolumeLocks(store, [first, second], Effect.void).pipe(Effect.result),
          { startImmediately: true },
        );
        yield* TestClock.adjust("90 seconds");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(firstBlocker);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("31 seconds");
        return yield* Fiber.join(union);
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds")),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { lockFailure: "timeout", resource: `volume ${second.name}`, timeoutMs: 30_000 },
    });
  });

  test("shared request is satisfied by an exclusive hold on the same fiber", async () => {
    // Given exclusive already held; shared nesting must not reacquire.
    const store = await liveStore();
    const key = "endpoint:test/data";
    const name = landoAppStoreName("app", "data");
    const acquired: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (lockKey, body, options) =>
        Effect.suspend(() => {
          acquired.push(lockKey);
          return store.withLock(lockKey, body, options);
        }),
    };

    const result = await Effect.runPromise(
      withPhysicalVolumeLock(
        recordingStore,
        request(key, name, "exclusive"),
        withPhysicalVolumeLock(recordingStore, request(key, name, "shared"), Effect.succeed("nested")),
      ).pipe(Effect.timeout("1 second")),
    );

    expect(result).toBe("nested");
    expect(acquired).toEqual([physicalVolumeLockKey(key)]);
  });

  test("exclusive waits behind a shared physical volume lock on another fiber", async () => {
    // Given a shared holder on the coordination key.
    const store = await liveStore();
    const key = "endpoint:test/composer";
    const name = landoCacheStoreName("composer");
    const sharedEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseShared = await Effect.runPromise(Deferred.make<void>());
    const exclusiveEntered = await Effect.runPromise(Deferred.make<void>());
    const shared = Effect.runFork(
      withPhysicalVolumeLock(
        store,
        request(key, name, "shared"),
        Deferred.succeed(sharedEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseShared))),
      ),
    );
    await Effect.runPromise(Deferred.await(sharedEntered));

    // When exclusive acquisition targets the same key.
    const exclusive = Effect.runFork(
      withPhysicalVolumeLock(
        store,
        request(key, name, "exclusive"),
        Deferred.succeed(exclusiveEntered, undefined),
      ),
    );
    const beforeRelease = await Effect.runPromise(Deferred.poll(exclusiveEntered));
    await Effect.runPromise(Deferred.succeed(releaseShared, undefined));
    await Effect.runPromise(Fiber.join(shared));
    await Effect.runPromise(Fiber.join(exclusive).pipe(Effect.timeout("2 seconds")));

    // Then exclusive waited for the shared holder.
    expect(beforeRelease._tag).toBe("None");
    expect((await Effect.runPromise(Deferred.poll(exclusiveEntered)))._tag).toBe("Some");
  });
});

describe("physical volume lock tier order", () => {
  test("acquires cache-tier keys after default-tier keys regardless of key sort", async () => {
    // Given a cache key that sorts before an app key as strings.
    const store = await liveStore();
    const cache = request("a-cache", landoCacheStoreName("composer"));
    const app = request("z-app", landoAppStoreName("zeta", "data"));
    const order: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (lockKey, body, options) =>
        Effect.suspend(() => {
          order.push(lockKey);
          return store.withLock(lockKey, body, options);
        }),
    };

    // When both are requested in reverse tier order.
    await Effect.runPromise(
      withPhysicalVolumeLocks(recordingStore, [cache, app], Effect.void).pipe(Effect.timeout("2 seconds")),
    );

    // Then default-tier app lock is taken before cache-tier lock.
    expect(order).toEqual([physicalVolumeLockKey(app.key), physicalVolumeLockKey(cache.key)]);
  });

  test("acquires global-app tier between default and cache", async () => {
    const store = await liveStore();
    const cache = request("key-cache", landoCacheStoreName("composer"));
    const globalApp = request("key-global", "lando-global--proxy--data");
    const app = request("key-app", landoAppStoreName("zeta", "data"));
    const order: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (lockKey, body, options) =>
        Effect.suspend(() => {
          order.push(lockKey);
          return store.withLock(lockKey, body, options);
        }),
    };

    await Effect.runPromise(
      withPhysicalVolumeLocks(recordingStore, [cache, globalApp, app], Effect.void).pipe(
        Effect.timeout("2 seconds"),
      ),
    );

    expect(order).toEqual([
      physicalVolumeLockKey(app.key),
      physicalVolumeLockKey(globalApp.key),
      physicalVolumeLockKey(cache.key),
    ]);
  });

  test("nested global-app lock is allowed while default-tier keys are held", async () => {
    // User start holds a tier-0 key; nested global ensure takes a tier-1 global-app key.
    const store = await liveStore();
    const app = request("endpoint:user/data", landoAppStoreName("zeta", "data"));
    const globalApp = request("endpoint:global/proxy", "lando-global--proxy--data");
    const acquired: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (lockKey, body, options) =>
        Effect.suspend(() => {
          acquired.push(lockKey);
          return store.withLock(lockKey, body, options);
        }),
    };

    const result = await Effect.runPromise(
      withPhysicalVolumeLock(
        recordingStore,
        app,
        withPhysicalVolumeLock(recordingStore, globalApp, Effect.succeed("nested-global")),
      ).pipe(Effect.timeout("2 seconds")),
    );

    expect(result).toBe("nested-global");
    expect(acquired).toEqual([physicalVolumeLockKey(app.key), physicalVolumeLockKey(globalApp.key)]);
  });

  test("nested default-tier key below a held cache key is an order defect", async () => {
    const store = await liveStore();
    const cache = request("endpoint:cache/composer", landoCacheStoreName("composer"));
    const app = request("endpoint:app/data", landoAppStoreName("alpha", "data"));

    const result = await Effect.runPromiseExit(
      withPhysicalVolumeLock(
        store,
        cache,
        withPhysicalVolumeLock(store, app, Effect.succeed("unreachable")),
      ).pipe(Effect.timeout("1 second")),
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) {
        expect(String(defect.success)).toContain("ordering violated");
        expect(String(defect.success)).toContain(app.key);
      }
    }
  });
});
