import { expect, test } from "bun:test";
import { join } from "node:path";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { makeSourceStore } from "../src/index.ts";
import { sourceRecords } from "../src/records.ts";
import { disposeTestSourceStore, makeTestSourceStore, withTestSession } from "../src/testing.ts";

test("first registration recreates a root retired after GC checked for live leases", async () => {
  const fixture = await makeTestSourceStore();
  const lockfile = join(fixture.root, "app", ".lando.lock.yml");
  const lockRequested = Promise.withResolvers<void>();
  const registered = Promise.withResolvers<void>();
  const closeSession = Promise.withResolvers<void>();
  let registration: Promise<void> | undefined;
  let racing = false;
  const stateStore: StateStoreShape = {
    open: fixture.stateStore.open,
    withLock: (key, body) => {
      if (racing) lockRequested.resolve();
      return fixture.stateStore.withLock(key, body);
    },
  };
  const store = makeSourceStore({ root: fixture.root, stateStore, transports: {} });
  try {
    await Effect.runPromise(withTestSession(store, (session) => session.registerRoot(lockfile)));
    let reads = 0;
    await Effect.runPromise(
      store
        .gc({
          prune: true,
          olderThanMs: 0,
          readLockKeys: () =>
            Effect.promise(async () => {
              reads++;
              if (reads === 2) {
                // Cleanup already checked live leases under its lock. Start an include walk now.
                racing = true;
                registration = Effect.runPromise(
                  withTestSession(store, (session) =>
                    session
                      .registerRoot(lockfile)
                      .pipe(
                        Effect.andThen(Effect.sync(() => registered.resolve())),
                        Effect.andThen(Effect.promise(() => closeSession.promise)),
                      ),
                  ),
                );
                await Promise.race([lockRequested.promise, registered.promise]);
              }
              return { status: "missing" as const };
            }),
        })
        .pipe(Effect.timeout("5 seconds")),
    );
    await Effect.runPromise(Effect.promise(() => registered.promise).pipe(Effect.timeout("5 seconds")));
    const bucket = await Effect.runPromise(sourceRecords(stateStore).root(lockfile));
    expect(await Effect.runPromise(bucket.get)).toMatchObject({ lockfile });
  } finally {
    closeSession.resolve();
    await registration;
    await disposeTestSourceStore(fixture);
  }
});
