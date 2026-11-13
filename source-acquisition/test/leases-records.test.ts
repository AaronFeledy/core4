import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { makeSourceStore } from "../src/index.ts";
import { sourceRecords } from "../src/records.ts";
import {
  disposeTestSourceStore,
  makeTestSourceStore,
  processIsAlive,
  withTestSession,
  withTestSources,
} from "../src/testing.ts";
import { makeFakeArchiveTransport, makeTarGz, sha256Of } from "./support.ts";

test("a session locks each warm entry once and registers roots only when absent", async () => {
  const archive = makeFakeArchiveTransport();
  const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("leased") }]);
  const url = "https://example.test/source.tgz";
  const sha256 = sha256Of(bytes);
  archive.set(url, bytes);
  const fixture = await makeTestSourceStore({ archive: archive.transport });
  let locks = 0;
  const store = makeSourceStore({
    transports: { archive: archive.transport },
    stateStore: {
      open: fixture.stateStore.open,
      withLock: (key, body) =>
        fixture.stateStore.withLock(
          key,
          Effect.sync(() => {
            locks++;
          }).pipe(Effect.andThen(body)),
        ),
    },
  });
  try {
    await Effect.runPromise(withTestSession(store, (session) => session.acquireArchive({ url, sha256 })));
    await Effect.runPromise(
      withTestSession(store, (session) =>
        Effect.gen(function* () {
          locks = 0;
          yield* session.openArchive(sha256);
          yield* session.openArchive(sha256);
          expect(locks).toBe(1);
          const lockfile = join(fixture.root, "app", ".lando.lock.yml");
          yield* session.registerRoot(lockfile);
          const bucket = yield* sourceRecords(fixture.stateStore).root(lockfile);
          const registered = yield* bucket.get;
          expect(registered?.lockfile).toBe(lockfile);
          locks = 0;
          yield* session.registerRoot(lockfile);
          expect(locks).toBe(0);
          expect(yield* bucket.get).toEqual(registered);
        }),
      ),
    );
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("lease liveness distinguishes a reaped child from the current process", async () => {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(processIsAlive(child.pid)).toBe(false);
  expect(processIsAlive(process.pid)).toBe(true);
  expect(processIsAlive(0)).toBe(false);
});

test("a failed lease write never marks a key registered in memory", async () => {
  const archive = makeFakeArchiveTransport();
  const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("retry") }]);
  const sha256 = sha256Of(bytes);
  const url = "https://example.test/retry.tgz";
  archive.set(url, bytes);
  await withTestSources({ archive: archive.transport }, ({ root, session }) =>
    Effect.gen(function* () {
      const [file] = yield* Effect.promise(() => readdir(join(root, ".leases")));
      if (file === undefined) throw new Error("Expected a session lease");
      const path = join(root, ".leases", file);
      const emptyLease = yield* Effect.promise(() => readFile(path, "utf8"));
      yield* Effect.promise(async () => {
        await rm(path);
        await mkdir(path);
      });
      const failed = yield* Effect.result(session.acquireArchive({ url, sha256 }));
      yield* Effect.promise(async () => {
        await rm(path, { recursive: true });
        await writeFile(path, emptyLease);
      });
      expect(failed).toMatchObject({ _tag: "Failure", failure: { kind: "cache" } });
      const snapshot = yield* session.openArchive(sha256);
      expect(snapshot?.key).toEqual({ kind: "archive", sha256 });
      const record: unknown = JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")));
      expect(record).toMatchObject({ keys: [{ kind: "archive", sha256 }] });
    }),
  );
});

test("stores sharing one StateStore use the same physical lock", async () => {
  const archive = makeFakeArchiveTransport();
  const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("warm") }]);
  const sha256 = sha256Of(bytes);
  const url = "https://example.test/warm.tgz";
  archive.set(url, bytes);
  const fixture = await makeTestSourceStore({ archive: archive.transport });
  const locks: string[] = [];
  const stateStore = {
    open: fixture.stateStore.open,
    withLock: <A, E, R>(key: string, body: Effect.Effect<A, E, R>) => {
      locks.push(key);
      return fixture.stateStore.withLock(key, body);
    },
  };
  try {
    await Effect.runPromise(
      withTestSession(fixture.store, (session) => session.acquireArchive({ url, sha256 })),
    );
    const firstStore = makeSourceStore({ stateStore, transports: {} });
    const secondStore = makeSourceStore({ stateStore, transports: {} });
    const first = await Effect.runPromise(
      withTestSession(firstStore, (session) => session.openArchive(sha256)),
    );
    const second = await Effect.runPromise(
      withTestSession(secondStore, (session) => session.openArchive(sha256)),
    );
    expect(first?.key).toEqual({ kind: "archive", sha256 });
    expect(second?.key).toEqual(first?.key);
    expect(locks).toHaveLength(2);
    expect(new Set(locks).size).toBe(1);
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("interruption joins an in-flight git transport before cleaning its stage and lease", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await makeTestSourceStore({
    git: {
      fetch: async ({ dest }) => {
        entered.resolve();
        await release.promise;
        await writeFile(join(dest, "late-file"), "body");
        return { commit: "a".repeat(40) };
      },
    },
  });
  const controller = new AbortController();
  try {
    const running = Effect.runPromiseExit(
      withTestSession(fixture.store, (session) =>
        session.acquireGit({ url: "https://example.test/r.git", ref: "main" }),
      ),
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    release.resolve();
    expect((await running)._tag).toBe("Failure");
    expect(await readdir(join(fixture.root, ".leases"))).toEqual([]);
    expect((await readdir(fixture.root)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
  } finally {
    release.resolve();
    await disposeTestSourceStore(fixture);
  }
});
