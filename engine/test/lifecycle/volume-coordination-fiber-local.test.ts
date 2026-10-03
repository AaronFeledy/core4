import { describe, expect, test } from "bun:test";
import type { VolumeRef } from "@lando/sdk/schema";
import { type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { Deferred, Effect, Fiber } from "effect";
import {
  verifyActiveVolumeCoordination,
  withPlanVolumeCoordination,
  withVolumeCoordinationLock,
} from "../../src/lifecycle/volume-coordination.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { planWith } from "../services/build-app-runner-test-support.ts";

const planFor = (name: string) => ({
  ...planWith({}),
  stores: [{ name, scope: "app" as const, kind: "data" as const }],
});
const fixture = () => {
  const namespace = crypto.randomUUID();
  const observations: string[] = [];
  const provider = {
    id: "test",
    locateVolume: (ref: VolumeRef) =>
      Effect.sync(() => {
        observations.push(ref.store);
        return { coordinationKey: `${namespace}:${ref.store}`, nativeName: ref.store };
      }),
  };
  return {
    provider,
    observations,
    store: makeTestStateStore().service,
    key: (name: string) => `${namespace}:${name}`,
  };
};

describe("volume coordination fiber-local state", () => {
  test("defaults to no active volumes, inherits both bindings in children, and restores both after exit", async () => {
    // Given
    const { provider, observations, store, key } = fixture();
    const locks: string[] = [];
    const recordingStore: StateStoreShape = {
      ...store,
      withLock: (lockKey, body) =>
        Effect.suspend(() => {
          locks.push(lockKey);
          return store.withLock(lockKey, body);
        }),
    };
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* verifyActiveVolumeCoordination(provider);
        yield* withVolumeCoordinationLock(recordingStore, key("alpha"), Effect.void);
        const bound = yield* withPlanVolumeCoordination({
          plan: planFor("alpha"),
          provider,
          stateStore: recordingStore,
          body: () =>
            Effect.gen(function* () {
              yield* verifyActiveVolumeCoordination(provider);
              const child = yield* Effect.forkChild(
                withVolumeCoordinationLock(
                  recordingStore,
                  key("alpha"),
                  verifyActiveVolumeCoordination(provider).pipe(Effect.as("inherited")),
                ),
              );
              return yield* Fiber.join(child);
            }),
        });
        yield* verifyActiveVolumeCoordination(provider);
        yield* withVolumeCoordinationLock(recordingStore, key("alpha"), Effect.void);
        return bound;
      }).pipe(Effect.timeout("2 seconds")),
    );
    // Then
    expect(result).toBe("inherited");
    expect(observations).toEqual(["alpha", "alpha", "alpha", "alpha"]);
    expect(locks).toEqual(Array(3).fill(physicalVolumeLockKey(key("alpha"))));
  });

  test("active verification detects a replacement inside the binding and clears the snapshot on failure", async () => {
    // Given
    const { provider, observations, store } = fixture();
    let replaced = false;
    const changingProvider = {
      ...provider,
      locateVolume: (ref: VolumeRef) =>
        provider.locateVolume(ref).pipe(
          Effect.map((locator) => ({
            ...locator,
            nativeName: replaced ? "replacement" : locator.nativeName,
          })),
        ),
    };
    // When
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const failure = yield* withPlanVolumeCoordination({
          plan: planFor("alpha"),
          provider: changingProvider,
          stateStore: store,
          body: () =>
            Effect.sync(() => {
              replaced = true;
            }).pipe(Effect.andThen(verifyActiveVolumeCoordination(changingProvider))),
        }).pipe(Effect.flip);
        yield* verifyActiveVolumeCoordination(changingProvider);
        return failure;
      }),
    );
    // Then
    expect(error).toMatchObject({ _tag: "VolumeOperationError", operation: "coordinateVolume" });
    expect(observations).toEqual(["alpha", "alpha", "alpha"]);
  });

  test("overlapping siblings verify only their own located volumes while the parent stays unbound", async () => {
    // Given
    const { provider, store } = fixture();
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const leftReady = yield* Deferred.make<void>();
          const rightReady = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const leftReads: string[] = [];
          const rightReads: string[] = [];
          const observer = (reads: string[]) => ({
            ...provider,
            locateVolume: (ref: VolumeRef) =>
              Effect.sync(() => {
                reads.push(ref.store);
              }).pipe(Effect.andThen(provider.locateVolume(ref))),
          });
          const left = yield* withPlanVolumeCoordination({
            plan: planFor("alpha"),
            provider,
            stateStore: store,
            body: () =>
              Deferred.succeed(leftReady, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(verifyActiveVolumeCoordination(observer(leftReads))),
              ),
          }).pipe(Effect.forkScoped);
          const right = yield* withPlanVolumeCoordination({
            plan: planFor("beta"),
            provider,
            stateStore: store,
            body: () =>
              Deferred.succeed(rightReady, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(verifyActiveVolumeCoordination(observer(rightReads))),
              ),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(leftReady);
          yield* Deferred.await(rightReady);
          const parentReads: string[] = [];
          yield* verifyActiveVolumeCoordination(observer(parentReads));
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(left);
          yield* Fiber.join(right);
          return { leftReads, rightReads, parentReads };
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );
    // Then
    expect(result).toEqual({ leftReads: ["alpha"], rightReads: ["beta"], parentReads: [] });
  });

  test("a sibling lifecycle does not borrow another fiber's held keys", async () => {
    // Given
    const { provider, store } = fixture();
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstEntered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const secondAttempt = yield* Deferred.make<void>();
          const secondEntered = yield* Deferred.make<void>();
          let attempts = 0;
          const observingStore: StateStoreShape = {
            ...store,
            withLock: (key, body) =>
              Effect.suspend(() => {
                attempts++;
                return (attempts === 2 ? Deferred.succeed(secondAttempt, undefined) : Effect.void).pipe(
                  Effect.andThen(store.withLock(key, body)),
                );
              }),
          };
          const first = yield* withPlanVolumeCoordination({
            plan: planFor("alpha"),
            provider,
            stateStore: observingStore,
            body: () =>
              Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstEntered);
          const second = yield* withPlanVolumeCoordination({
            plan: planFor("alpha"),
            provider,
            stateStore: observingStore,
            body: () => Deferred.succeed(secondEntered, undefined).pipe(Effect.as("second")),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(secondAttempt);
          const waiting = yield* Deferred.poll(secondEntered);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          return { waiting, second: yield* Fiber.join(second), attempts };
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );
    // Then
    expect(result.waiting._tag).toBe("None");
    expect(result.second).toBe("second");
    expect(result.attempts).toBe(2);
  });
});
