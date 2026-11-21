import { expect, test } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import type { StateStoreShape, VolumeArchiveImportSpec } from "@lando/sdk/services";
import type { TestRuntimeProvider } from "@lando/sdk/test";
import { withPhysicalVolumeLock } from "@lando/state-store/volume-lock";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { run, runScoped, store, withCatalog } from "./catalog-fixture.ts";
import { tarArchive } from "./tar-fixture.ts";

test("two child imports under one holder serialize on the volume transaction gate", async () => {
  await withCatalog(async (f) => {
    const archive = tarArchive([{ name: "payload", data: "new-data" }]);
    const lockRequest = await run(
      f.recording
        .locateVolume(store)
        .pipe(Effect.map((locator) => ({ key: locator.coordinationKey, name: locator.nativeName }))),
    );
    let active = 0;
    let peak = 0;
    const provider = f.provider({
      listVolumes: () => Effect.succeed([]),
      exportVolume: () => Stream.make(archive),
      importVolume: <E, R>(spec: VolumeArchiveImportSpec<E, R>) =>
        Effect.gen(function* () {
          active += 1;
          peak = Math.max(peak, active);
          yield* Stream.runDrain(spec.archive);
          yield* spec.beforeCommit;
          yield* Effect.sleep("50 millis");
          active -= 1;
        }),
    });

    await runScoped(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(
          f.mover(provider).transfer({
            from: { _tag: "volume", app: store.app, store: store.store },
            to: { _tag: "volume", app: store.app, store: store.store },
          }),
        );
        const second = yield* Effect.forkChild(
          f.mover(provider).transfer({
            from: { _tag: "volume", app: store.app, store: store.store },
            to: { _tag: "volume", app: store.app, store: store.store },
          }),
        );
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }).pipe((body) => withPhysicalVolumeLock(f.stateStore, lockRequest, body)),
    );

    expect(peak).toBe(1);
  });
});

test("a lock holder's own transfer is not blocked by a non-holder waiting for the lock", async () => {
  await withCatalog(async (f) => {
    const archive = tarArchive([{ name: "payload", data: "new-data" }]);
    const lockRequest = await run(
      f.recording
        .locateVolume(store)
        .pipe(Effect.map((locator) => ({ key: locator.coordinationKey, name: locator.nativeName }))),
    );
    const transfer = {
      from: { _tag: "volume", app: store.app, store: store.store },
      to: { _tag: "volume", app: store.app, store: store.store },
    } as const;
    const provider = f.provider({
      listVolumes: () => Effect.succeed([]),
      exportVolume: () => Stream.make(archive),
      importVolume: <E, R>(spec: VolumeArchiveImportSpec<E, R>) =>
        Stream.runDrain(spec.archive).pipe(Effect.andThen(spec.beforeCommit)),
    });

    await runScoped(
      Effect.gen(function* () {
        const holderLocked = yield* Deferred.make<void>();
        const outsiderWaiting = yield* Deferred.make<void>();
        let lockAttempts = 0;
        // The holder's acquisition is the first attempt; the outsider's blocked attempt is the second.
        const observingStore: StateStoreShape = {
          ...f.stateStore,
          withLock: <A, E, R>(key: string, body: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              lockAttempts += 1;
              if (lockAttempts === 2) yield* Deferred.succeed(outsiderWaiting, undefined);
              return yield* f.stateStore.withLock(key, body);
            }),
        };
        const mover = f.mover(provider, observingStore);
        // Like SQL recovery: hold the physical lock, then call DataMover on the same volume.
        const holder = yield* Effect.forkChild(
          withPhysicalVolumeLock(
            observingStore,
            lockRequest,
            Effect.gen(function* () {
              yield* Deferred.succeed(holderLocked, undefined);
              yield* Deferred.await(outsiderWaiting);
              yield* mover.transfer(transfer);
            }),
          ),
        );
        yield* Deferred.await(holderLocked);
        const outsider = yield* Effect.forkChild(mover.transfer(transfer));
        yield* Fiber.join(holder).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.join(outsider).pipe(Effect.timeout("5 seconds"));
      }),
    );
  });
});

test("snapshot observes the source only after it holds the volume lock", async () => {
  await withCatalog(async (f) => {
    let holding = false;
    let observedWhileHolding: boolean | undefined;
    const countingStore: StateStoreShape = {
      ...f.stateStore,
      withLock: <A, E, R>(_key: string, body: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          holding = true;
        }).pipe(
          Effect.andThen(body),
          Effect.ensuring(
            Effect.sync(() => {
              holding = false;
            }),
          ),
        ),
    };
    const base = f.recording;
    const provider = f.provider({
      listVolumes: (filter) =>
        base.listVolumes(filter).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              observedWhileHolding = holding;
            }),
          ),
        ),
    });

    await runScoped(
      f.mover(provider, countingStore).snapshot(store, { volumeSnapshot: "copy", format: "tar" }),
    );

    expect(observedWhileHolding).toBe(true);
  });
});

test("a volume read fails instead of hanging when the volume lock cannot be taken", async () => {
  await withCatalog(async (f) => {
    const lockedOut: StateStoreShape = {
      ...f.stateStore,
      withLock: () =>
        Effect.fail(
          new StateStoreError({
            reason: "lock",
            operation: "withLock",
            remediation: "Retry after the other operation finishes.",
          }),
        ),
    };

    const result = await runScoped(
      f
        .mover(f.recording, lockedOut)
        .read({ _tag: "volume", app: store.app, store: store.store })
        .pipe(Stream.runDrain, Effect.timeout("5 seconds"), Effect.result),
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataTransferError" } });
  });
});

test("native restore refuses a target replaced after the snapshot was admitted", async () => {
  await withCatalog(async (f) => {
    const source = (await run(f.recording.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const identity = source.identity;
    const handle = await runScoped(
      f.mover().snapshot(store, {
        metadata: {
          service: ServiceName.make("database"),
          volumeInstanceId: identity.generation,
          family: "mysql",
          version: "8.0",
          imageIdentity: "sha256:mysql-runtime",
          recoveryReason: "manual",
        },
      }),
    );
    let observations = 0;
    let applied = false;
    const provider = f.provider({
      // The second observation is the pre-publication recheck: the volume was replaced.
      listVolumes: (filter) =>
        f.recording.listVolumes(filter).pipe(
          Effect.map((volumes) => {
            observations += 1;
            return observations < 2
              ? volumes
              : volumes.map((volume) =>
                  volume.identity === undefined
                    ? volume
                    : {
                        ...volume,
                        instanceId: "00000000-0000-4000-8000-0000000000aa",
                        identity: { ...volume.identity, generation: "00000000-0000-4000-8000-0000000000aa" },
                      },
                );
          }),
        ),
      restoreVolume: <E = never>(
        spec: Parameters<typeof TestRuntimeProvider.restoreVolume>[0],
        options?: { readonly beforeCommit?: Effect.Effect<void, E> },
      ) =>
        Effect.gen(function* () {
          if (options?.beforeCommit !== undefined) yield* options.beforeCommit;
          applied = spec.overwrite === true;
        }),
    });

    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotOwnershipError" } });
    expect(applied).toBe(false);
  });
});
