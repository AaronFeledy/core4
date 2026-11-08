import { expect, test } from "bun:test";
import { lstat, readFile } from "node:fs/promises";
import { Effect } from "effect";
import { type Journal, type TransactionLock, openJournal } from "../src/transaction-journal.ts";
import { fixture, ownerOnlyFileAccess, scoped } from "./transaction-fixture.ts";

type Store = Effect.Success<ReturnType<typeof openJournal>>;
type Operation = "prepare" | "beginCommit" | "finishCommit" | "block" | "removeCommitted";
const phase = {
  prepare: "prepare",
  beginCommit: "commit",
  finishCommit: "commit",
  block: "recover",
  removeCommitted: "cleanup",
} as const;
const illegal: ReadonlyArray<readonly [Journal["state"] | "absent", ReadonlyArray<Operation>]> = [
  ["absent", ["beginCommit", "finishCommit", "block", "removeCommitted"]],
  ["prepared", ["prepare", "finishCommit", "removeCommitted"]],
  ["committing", ["prepare", "removeCommitted"]],
  ["committed", ["prepare", "beginCommit", "finishCommit", "block"]],
  ["blocked", ["prepare", "beginCommit", "finishCommit", "block", "removeCommitted"]],
];

const withJournal = async <A, E>(
  use: (store: Store, lock: TransactionLock, root: string) => Effect.Effect<A, E>,
) => {
  const { appRoot, dataRoot } = await fixture();
  return scoped(
    Effect.gen(function* () {
      const store = yield* openJournal(appRoot, dataRoot, { privateFileAccess: ownerOnlyFileAccess });
      return yield* use(store, yield* store.acquireLock("prepare"), appRoot);
    }),
  );
};

for (const [state, operations] of illegal) {
  for (const operation of operations) {
    test(`${operation} refuses a ${state} journal without modifying it`, async () => {
      await withJournal((store, lock, root) =>
        Effect.gen(function* () {
          if (state !== "absent") yield* store.prepare(lock, { id: "original", root, entries: [] });
          if (state === "committing" || state === "committed") yield* store.beginCommit(lock);
          if (state === "committed") yield* store.finishCommit(lock);
          if (state === "blocked") yield* store.block(lock);
          const before = yield* store.read;

          const result = yield* Effect.result(
            operation === "prepare"
              ? store.prepare(lock, { id: "replacement", root, entries: [] })
              : store[operation](lock),
          );

          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ManagedFileTransactionError", reason: "journal", phase: phase[operation] },
          });
          expect(yield* store.read).toEqual(before);
        }),
      );
    });
  }
}

test("resuming begin-commit preserves journal bytes and inode without a write", async () => {
  await withJournal((store, lock, root) =>
    Effect.gen(function* () {
      yield* store.prepare(lock, { id: "original", root, entries: [], directoryPolicy: [] });
      yield* store.beginCommit(lock);
      const before = yield* Effect.promise(() => lstat(store.path, { bigint: true }));
      const bytes = yield* Effect.promise(() => readFile(store.path, "utf8"));

      yield* store.beginCommit(lock);

      const after = yield* Effect.promise(() => lstat(store.path, { bigint: true }));
      expect({ ino: after.ino, mtime: after.mtimeNs }).toEqual({ ino: before.ino, mtime: before.mtimeNs });
      expect(yield* Effect.promise(() => readFile(store.path, "utf8"))).toBe(bytes);
    }),
  );
});

test("journal operations preserve prepared metadata through commit", async () => {
  await withJournal((store, lock, root) =>
    Effect.gen(function* () {
      const body = {
        id: "immutable",
        root,
        entries: [],
        directoryPolicy: [{ path: "nested", action: "create-if-absent" as const }],
      };
      yield* store.prepare(lock, body);
      yield* store.beginCommit(lock);
      yield* store.finishCommit(lock);
      expect(yield* store.read).toEqual({ ...body, state: "committed" });
    }),
  );
});

test("journal writes refuse a released lock and a lock on another journal", async () => {
  const { appRoot, dataRoot } = await fixture();
  const other = await fixture();
  await scoped(
    Effect.gen(function* () {
      const store = yield* openJournal(appRoot, dataRoot, { privateFileAccess: ownerOnlyFileAccess });
      const released = yield* Effect.scoped(store.acquireLock("prepare"));
      const otherStore = yield* openJournal(other.appRoot, other.dataRoot, {
        privateFileAccess: ownerOnlyFileAccess,
      });
      const foreign = yield* otherStore.acquireLock("prepare");

      for (const lock of [released, foreign]) {
        const result = yield* Effect.result(
          store.prepare(lock, { id: "unlocked", root: appRoot, entries: [] }),
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "lock", phase: "prepare" } });
      }
      expect(yield* store.read).toBeNull();
    }),
  );
});
