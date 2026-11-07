import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { makeStorage } from "../src/storage.ts";
import { disposeTestSourceStore, makeTestSourceStore, withTestSession } from "../src/testing.ts";
import { makeFakeArchiveTransport, makeTarGz, sha256Of } from "./support.ts";

test("a released session rejects warm and cold opens and root registration", async () => {
  const archive = makeFakeArchiveTransport();
  const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("leased") }]);
  const sha256 = sha256Of(bytes);
  const url = "https://example.test/source.tgz";
  archive.set(url, bytes);
  const fixture = await makeTestSourceStore({ archive: archive.transport });
  try {
    const session = await Effect.runPromise(
      withTestSession(fixture.store, (session) =>
        session.acquireArchive({ url, sha256 }).pipe(Effect.as(session)),
      ),
    );
    for (const action of [
      session.openArchive(sha256),
      session.openArchive("b".repeat(64)),
      session.registerRoot(join(fixture.root, "app.lock")),
    ]) {
      expect(await Effect.runPromise(Effect.result(action))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "cache", message: expect.stringContaining("while released") },
      });
    }
    expect(await fs.readdir(join(fixture.root, ".leases"))).toEqual([]);
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("lease initialization is exclusive and release is terminal and idempotent", async () => {
  const fixture = await makeTestSourceStore();
  const storage = makeStorage({ stateStore: fixture.stateStore, transports: {} }, fixture.root, {
    token: "lifecycle",
    createdAt: 1,
  });
  try {
    expect(await Effect.runPromise(Effect.result(storage.release))).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("while absent") },
    });
    await Effect.runPromise(storage.initialize);
    expect(await Effect.runPromise(Effect.result(storage.initialize))).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("while open") },
    });
    await Effect.runPromise(storage.release);
    await Effect.runPromise(storage.release);
    expect(await Effect.runPromise(Effect.result(storage.initialize))).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("while released") },
    });
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("lease commit survives stage cleanup failure without losing the committed key on the next write", async () => {
  const archive = makeFakeArchiveTransport();
  const pins = ["first", "second"].map((name) => {
    const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode(name) }]);
    const url = `https://example.test/${name}.tgz`;
    archive.set(url, bytes);
    return { url, sha256: sha256Of(bytes) };
  });
  const fixture = await makeTestSourceStore({ archive: archive.transport });
  try {
    await Effect.runPromise(
      withTestSession(fixture.store, (session) => Effect.forEach(pins, (pin) => session.acquireArchive(pin))),
    );
    await Effect.runPromise(
      withTestSession(fixture.store, (session) =>
        Effect.gen(function* () {
          const first = pins[0];
          const second = pins[1];
          if (first === undefined || second === undefined) throw new Error("Missing pins");
          const failingCleanup = spyOn(fs, "rm").mockImplementationOnce(async () => {
            throw new Error("injected stage cleanup failure");
          });
          try {
            const result = yield* Effect.exit(session.openArchive(first.sha256));
            expect(result._tag).toBe("Failure");
          } finally {
            failingCleanup.mockRestore();
          }
          yield* session.openArchive(second.sha256);
          const files = yield* Effect.promise(() => fs.readdir(join(fixture.root, ".leases")));
          const lease = files[0];
          if (lease === undefined) throw new Error("Missing lease");
          const record = JSON.parse(
            yield* Effect.promise(() => fs.readFile(join(fixture.root, ".leases", lease), "utf8")),
          );
          expect(record.keys).toEqual(pins.map(({ sha256 }) => ({ kind: "archive", sha256 })));
        }),
      ),
    );
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("publication after release cannot recreate a lease or install a tree", async () => {
  const fixture = await makeTestSourceStore();
  const storage = makeStorage({ stateStore: fixture.stateStore, transports: {} }, fixture.root, {
    token: "late",
    createdAt: 1,
  });
  try {
    await Effect.runPromise(storage.initialize);
    await Effect.runPromise(storage.release);
    const sha256 = "a".repeat(64);
    const result = await Effect.runPromise(
      Effect.result(
        storage.stage((stage) =>
          storage.publish({
            key: { kind: "archive", sha256 },
            pin: { kind: "archive", sha256, url: "https://example.test/a.tgz" },
            stage,
            repair: false,
            source: "fixture",
          }),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("while released") },
    });
    expect(await fs.readdir(join(fixture.root, ".leases"))).toEqual([]);
    await expect(fs.access(join(fixture.root, "archive", sha256))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("utimes failure leaves lease keys unchanged and a later open can register", async () => {
  const archive = makeFakeArchiveTransport();
  const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("touch") }]);
  const sha256 = sha256Of(bytes);
  const url = "https://example.test/touch.tgz";
  archive.set(url, bytes);
  const fixture = await makeTestSourceStore({ archive: archive.transport });
  try {
    await Effect.runPromise(
      withTestSession(fixture.store, (session) => session.acquireArchive({ url, sha256 })),
    );
    await Effect.runPromise(
      withTestSession(fixture.store, (session) =>
        Effect.gen(function* () {
          const files = yield* Effect.promise(() => fs.readdir(join(fixture.root, ".leases")));
          const lease = files[0];
          if (lease === undefined) throw new Error("Missing lease");
          const path = join(fixture.root, ".leases", lease);
          const before = yield* Effect.promise(() => fs.readFile(path, "utf8"));
          const touch = spyOn(fs, "utimes").mockRejectedValueOnce(new Error("injected utimes failure"));
          try {
            expect(yield* Effect.result(session.openArchive(sha256))).toMatchObject({
              _tag: "Failure",
              failure: { kind: "cache" },
            });
          } finally {
            touch.mockRestore();
          }
          expect(yield* Effect.promise(() => fs.readFile(path, "utf8"))).toBe(before);
          yield* session.openArchive(sha256);
          expect(JSON.parse(yield* Effect.promise(() => fs.readFile(path, "utf8"))).keys).toEqual([
            { kind: "archive", sha256 },
          ]);
        }),
      ),
    );
  } finally {
    await disposeTestSourceStore(fixture);
  }
});

test("release waits for an in-flight registration and cannot be undone by it", async () => {
  const fixture = await makeTestSourceStore();
  const storage = makeStorage({ stateStore: fixture.stateStore, transports: {} }, fixture.root, {
    token: "race",
    createdAt: 1,
  });
  const sha256 = "a".repeat(64);
  const key = { kind: "archive", sha256 } as const;
  const pin = { ...key, url: "https://example.test/a.tgz" };
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const touch = fs.utimes;
  let pending: Promise<unknown> | undefined;
  try {
    await fs.mkdir(join(fixture.root, "archive", sha256, "tree"), { recursive: true });
    await fs.writeFile(
      join(fixture.root, "archive", sha256, "entry.json"),
      JSON.stringify({
        version: 1,
        format: 1,
        kind: "archive",
        id: sha256,
        treeDigest: "b".repeat(64),
        provenance: { source: "fixture" },
      }),
    );
    await Effect.runPromise(storage.initialize);
    const blocked = spyOn(fs, "utimes").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return touch(...args);
    });
    try {
      const opening = Effect.runPromise(storage.open(key, pin));
      pending = opening;
      await entered.promise;
      const releasing = Effect.runPromise(storage.release);
      pending = Promise.all([opening, releasing]);
      resume.resolve();
      await pending;
    } finally {
      resume.resolve();
      blocked.mockRestore();
      await pending;
    }
    expect(await fs.readdir(join(fixture.root, ".leases"))).toEqual([]);
    expect(await Effect.runPromise(Effect.result(storage.open(key, pin)))).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("while released") },
    });
  } finally {
    resume.resolve();
    await disposeTestSourceStore(fixture);
  }
});
