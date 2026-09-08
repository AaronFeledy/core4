import { basename, dirname } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { syncDirectory } from "@lando/state-store/atomic";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Schema } from "effect";
import { transactionError, transactionIO } from "./transaction-error.ts";
import { digestOf, ensureDirectory, statMaybe } from "./transaction-fs.ts";

const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const Mode = Schema.Number.pipe(Schema.int(), Schema.between(0, 0o7777));
const Absent = Schema.Struct({ present: Schema.Literal(false) });
export const FileState = Schema.Union(
  Absent,
  Schema.Struct({
    present: Schema.Literal(true),
    digest: Digest,
    mode: Mode,
  }),
);
export type FileState = typeof FileState.Type;
const Before = Schema.Union(
  Absent,
  Schema.Struct({
    present: Schema.Literal(true),
    digest: Digest,
    mode: Mode,
    backup: Schema.String,
  }),
);
export const Stage = Schema.Struct({ path: Schema.String, dev: Schema.String, ino: Schema.String });
export type Stage = typeof Stage.Type;
export const Entry = Schema.Struct({
  path: Schema.String,
  before: Before,
  after: FileState,
  stage: Schema.optional(Stage),
});
export type Entry = typeof Entry.Type;
export const Journal = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  state: Schema.Literal("prepared", "committing", "committed", "blocked"),
  entries: Schema.Array(Entry),
});
export type Journal = typeof Journal.Type;
const transitions = {
  prepared: "committing",
  committing: "committed",
  committed: null,
  blocked: null,
} as const;
const blockable = new Set<Journal["state"]>(["prepared", "committing"]);

export const journalDirectory = (root: string, userDataRoot: string): string =>
  dirname(
    makeLandoPaths({ userDataRoot }).managedFileLedger(
      `${basename(root).replace(/[^A-Za-z0-9._-]/gu, "-")}-${digestOf(root)}`,
    ),
  );

export const openJournal = (
  root: string,
  dir: string,
  options: { readonly createDirectory?: boolean } = {},
) =>
  Effect.gen(function* () {
    if (options.createDirectory !== false) yield* transactionIO("inspect", () => ensureDirectory(dir));
    const bucket = yield* makeStateStore()
      .open({
        root: { path: Schema.decodeUnknownSync(AbsolutePath)(dir) },
        key: "transaction.json",
        version: 1,
        schema: Journal,
        mode: 0o600,
        lock: "none",
        onCorrupt: "fail",
        onVersionMismatch: () => {
          throw transactionError("journal", "inspect");
        },
      })
      .pipe(Effect.mapError(() => transactionError("journal", "inspect")));
    const read = Effect.gen(function* () {
      const stats = yield* transactionIO("inspect", () => statMaybe(bucket.path));
      if (
        stats !== null &&
        (!stats.isFile() ||
          stats.isSymbolicLink() ||
          stats.nlink !== 1 ||
          (process.platform !== "win32" && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())))
      ) {
        return yield* Effect.fail(transactionError("journal", "inspect"));
      }
      const journal = yield* bucket.get.pipe(Effect.mapError(() => transactionError("journal", "inspect")));
      if (journal !== null && journal.root !== root)
        return yield* Effect.fail(transactionError("journal", "inspect"));
      return journal;
    });
    const write = (journal: Journal) =>
      Effect.gen(function* () {
        const previous = yield* read;
        const nextState = previous === null ? "prepared" : transitions[previous.state];
        if (
          journal.root !== root ||
          journal.state !== nextState ||
          (previous !== null &&
            JSON.stringify({ ...previous, state: journal.state }) !== JSON.stringify(journal))
        ) {
          return yield* Effect.fail(transactionError("journal", "commit"));
        }
        yield* bucket.set(journal).pipe(Effect.mapError(() => transactionError("journal", "commit")));
      }).pipe(Effect.uninterruptible);
    const block = Effect.gen(function* () {
      const previous = yield* read;
      if (previous === null || !blockable.has(previous.state))
        return yield* Effect.fail(transactionError("journal", "recover"));
      yield* bucket
        .set({ ...previous, state: "blocked" })
        .pipe(Effect.mapError(() => transactionError("journal", "recover")));
    }).pipe(Effect.uninterruptible);
    const removeCommitted = Effect.gen(function* () {
      const journal = yield* read;
      if (journal?.state !== "committed") return yield* Effect.fail(transactionError("journal", "cleanup"));
      yield* bucket.remove.pipe(Effect.mapError(() => transactionError("journal", "cleanup")));
      yield* transactionIO("cleanup", () => syncDirectory(dir));
    }).pipe(Effect.uninterruptible);
    return { path: bucket.path, read, write, block, removeCommitted };
  });
