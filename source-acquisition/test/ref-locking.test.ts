import { expect, test } from "bun:test";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { makeSourceStore } from "../src/index.ts";
import { sourceRecords } from "../src/records.ts";
import { withTestSession } from "../src/testing.ts";
import { disposeGcFixture, makeGcFixture, publishGit, runGc } from "./gc-support.ts";

test("floating ref publication holds the source store lock", async () => {
  const fixture = await makeGcFixture();
  let held = false;
  const stateStore: StateStoreShape = {
    open: (spec) =>
      fixture.stateStore.open(spec).pipe(
        Effect.map((bucket) => ({
          ...bucket,
          set: (value) =>
            Effect.gen(function* () {
              if (spec.key.startsWith("ref-")) expect(held).toBe(true);
              yield* bucket.set(value);
            }),
        })),
      ),
    withLock: (key, body) =>
      fixture.stateStore.withLock(
        key,
        Effect.acquireUseRelease(
          Effect.sync(() => {
            held = true;
          }),
          () => body,
          () =>
            Effect.sync(() => {
              held = false;
            }),
        ),
      ),
  };
  const store = makeSourceStore({
    stateStore,
    transports: { git: fixture.git.transport },
  });
  try {
    fixture.git.setRef("main", "a".repeat(40), { "file.txt": "source" });
    const snapshot = await Effect.runPromise(
      withTestSession(store, (session) =>
        session.acquireGit({ url: "https://git.test/source", ref: "main" }),
      ),
    );
    expect(snapshot.pin.commit).toBe("a".repeat(40));
    const ref = await Effect.runPromise(sourceRecords(stateStore).ref("https://git.test/source", "main"));
    expect(await Effect.runPromise(ref.get)).toEqual({ commit: "a".repeat(40) });
  } finally {
    await disposeGcFixture(fixture);
  }
});

test("GC re-reads a dangling ref before removing a concurrently refreshed record", async () => {
  const fixture = await makeGcFixture();
  try {
    const commit = "b".repeat(40);
    await publishGit(fixture, commit);
    const records = sourceRecords(fixture.stateStore);
    const ref = await Effect.runPromise(records.ref("https://git.test/refresh", "main"));
    await Effect.runPromise(ref.set({ commit: "a".repeat(40) }));
    const root = await Effect.runPromise(records.root("/app/.lando.lock.yml"));
    await Effect.runPromise(root.set({ lockfile: "/app/.lando.lock.yml", updatedAt: 0 }));
    let refreshed = false;

    const report = await runGc(fixture.store, {
      prune: true,
      olderThanMs: 0,
      readLockKeys: () =>
        Effect.gen(function* () {
          if (!refreshed) {
            refreshed = true;
            yield* ref.set({ commit }).pipe(Effect.orDie);
          }
          return { status: "ok" as const, keys: [] };
        }),
    });
    expect(report.leftovers.find((row) => row.id === ref.path.split("/").at(-1))).toMatchObject({
      eligible: false,
      outcome: "kept",
      reason: "entry-present",
    });
    expect(await Effect.runPromise(ref.get)).toEqual({ commit });
  } finally {
    await disposeGcFixture(fixture);
  }
});
