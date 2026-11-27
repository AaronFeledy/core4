import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import { makeTestRuntimeProvider } from "@lando/sdk/test";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect } from "effect";
import { run, runScoped, store, withCatalog } from "./catalog-fixture.ts";
import { writeFixtureVolume } from "./support.ts";

test("native seed admits and revalidates the claim in one lock acquisition", async () => {
  await withCatalog(async (f) => {
    const physical = makeTestRuntimeProvider();
    await runScoped(writeFixtureVolume(physical, store, "native seed source"));
    const base = f.provider({ listVolumes: physical.listVolumes, locateVolume: physical.locateVolume });
    const source = (await run(base.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const identity = source.identity;
    const handle = await runScoped(
      f.mover(base).snapshot(store, {
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
    const initialization = await run(volumeInitialization(f.stateStore, identity));
    await run(initialization.recordCreation);
    expect(await run(initialization.begin("seed-test"))).toBe(true);

    let applied = false;
    let revalidationEntered = false;
    let volumeLocks = 0;
    const lockKey = physicalVolumeLockKey(identity.coordinationKey);
    const countingStore: StateStoreShape = {
      ...f.stateStore,
      withLock: (key, body) => {
        if (key === lockKey) volumeLocks += 1;
        return f.stateStore.withLock(key, body);
      },
    };
    const provider: typeof base = {
      ...base,
      restoreVolume: <E = never>(
        spec: Parameters<typeof base.restoreVolume>[0],
        options?: { readonly beforeCommit?: Effect.Effect<void, E> },
      ) =>
        Effect.gen(function* () {
          // The claim is revoked after admission but before the provider's
          // pre-publication recheck, which must refuse the restore.
          const current = yield* volumeInitialization(f.stateStore, identity).pipe(Effect.orDie);
          yield* current.finish({ operationId: "seed-test", outcome: "failed" }).pipe(Effect.orDie);
          if (options?.beforeCommit !== undefined) {
            revalidationEntered = true;
            yield* options.beforeCommit;
          }
          applied = spec.overwrite === true;
        }),
    };

    const result = await runScoped(
      f.mover(provider, countingStore).restore(handle, store, { mode: "seed" }).pipe(Effect.result),
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotOwnershipError" } });
    expect(revalidationEntered).toBe(true);
    expect(applied).toBe(false);
    expect(volumeLocks).toBe(1);
  });
});
