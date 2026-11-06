import { basename, dirname, join, sep } from "node:path";
import { managedFileLedgerPath } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath } from "@lando/sdk/schema";
import type { StateWrite } from "@lando/sdk/services";
import { defineTransitions } from "@lando/sdk/transitions";
import { syncDirectory } from "@lando/state-store/atomic";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { realpathOrDeepestExisting } from "@lando/state-store/paths";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Schema } from "effect";
import { ManagedFileTransactionError, transactionError, transactionIO } from "./transaction-error.ts";
import { ensureDirectory, statMaybe } from "./transaction-fs.ts";

const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const Mode = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 0o7777 })),
);
const Absent = Schema.Struct({ present: Schema.Literal(false) });
export const FileState = Schema.Union([
  Absent,
  Schema.Struct({
    present: Schema.Literal(true),
    digest: Digest,
    mode: Mode,
  }),
]);
export type FileState = typeof FileState.Type;
const Before = Schema.Union([
  Absent,
  Schema.Struct({
    present: Schema.Literal(true),
    digest: Digest,
    mode: Mode,
    backup: Schema.String,
  }),
]);
export const Stage = Schema.Struct({ path: Schema.String, dev: Schema.String, ino: Schema.String });
export type Stage = typeof Stage.Type;
export const DirectoryPolicy = Schema.Struct({
  path: Schema.String,
  action: Schema.Literal("create-if-absent"),
});
export type DirectoryPolicy = typeof DirectoryPolicy.Type;
export const Entry = Schema.Struct({
  path: Schema.String,
  before: Before,
  after: FileState,
  stage: Schema.optionalKey(Stage),
  publication: Schema.optionalKey(Schema.Literals(["replace", "create"])),
});
export type Entry = typeof Entry.Type;
export const Journal = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  state: Schema.Literals(["prepared", "committing", "committed", "blocked"]),
  entries: Schema.Array(Entry),
  directoryPolicy: Schema.optionalKey(Schema.Array(DirectoryPolicy)),
});
export type Journal = typeof Journal.Type;
export const JOURNAL_VERSION = 2;
export const journalTransitions = defineTransitions<Journal["state"] | "absent">()({
  prepare: { from: ["absent"], to: "prepared" },
  "begin-commit": { from: ["prepared"], to: "committing", settledIn: ["committing"] },
  "finish-commit": { from: ["committing"], to: "committed" },
  block: { from: ["prepared", "committing"], to: "blocked" },
  "remove-committed": { from: ["committed"], to: "absent" },
});
type JournalOperation = keyof typeof journalTransitions.edges;
type JournalCommand =
  | { readonly operation: "prepare"; readonly body: Omit<Journal, "state"> }
  | { readonly operation: Exclude<JournalOperation, "prepare"> };
const operationPhase = {
  prepare: "prepare",
  "begin-commit": "commit",
  "finish-commit": "commit",
  block: "recover",
  "remove-committed": "cleanup",
} as const;

export const journalDirectory = (root: string, userDataRoot: string): string =>
  dirname(
    managedFileLedgerPath(
      userDataRoot,
      `${basename(root).replace(/[^A-Za-z0-9._-]/gu, "-")}-${sha256Hex(root)}`,
      sep === "\\" ? "win32" : "linux",
    ),
  );

/**
 * Proof that the caller holds the coordinator's `transaction.lock` for one
 * journal directory. Only `acquireLock` on an open journal mints it, and it
 * stops matching once the acquiring scope closes, so a journal write without
 * the lock is a type error and a write with a stale or foreign lock fails.
 */
class HeldTransactionLock {
  #directory: string | null;
  constructor(directory: string) {
    this.#directory = directory;
  }
  holds(directory: string): boolean {
    return this.#directory === directory;
  }
  static release(lock: HeldTransactionLock): void {
    lock.#directory = null;
  }
}
export type TransactionLock = HeldTransactionLock;

export const openJournal = Effect.fnUntraced(function* (
  root: string,
  userDataRoot: string,
  options: {
    readonly createDirectory?: boolean;
    readonly privateFileAccess: PrivateFileAccess;
  },
) {
  const privateFileAccess = options.privateFileAccess;
  const boundary = yield* transactionIO("inspect", () => realpathOrDeepestExisting(userDataRoot));
  const dir = journalDirectory(root, boundary);
  yield* transactionIO("inspect", () => ensureDirectory(dir, boundary, options.createDirectory));
  const bucket = yield* makeStateStore({ privateFileAccess })
    .open({
      root: { path: Schema.decodeUnknownSync(AbsolutePath)(dir) },
      key: "transaction.json",
      version: JOURNAL_VERSION,
      schema: Journal,
      mode: 0o600,
      // Writes are serialized by the coordinator's `transaction.lock`, which
      // every write method demands as a `TransactionLock`.
      lock: "none",
      onCorrupt: "fail",
      onVersionMismatch: (payload, fromVersion) => {
        if (fromVersion !== 1) throw transactionError("journal", "inspect");
        return Schema.decodeUnknownSync(Journal)(payload);
      },
    })
    .pipe(Effect.mapError(() => transactionError("journal", "inspect")));
  const inspectFile = Effect.gen(function* () {
    const stats = yield* transactionIO("inspect", () => statMaybe(bucket.path));
    if (stats === null) return;
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (process.platform !== "win32" && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()))
    ) {
      return yield* Effect.fail(transactionError("journal", "inspect"));
    }
    yield* transactionIO("inspect", () => privateFileAccess.verify(bucket.path)).pipe(
      Effect.mapError(() => transactionError("journal", "inspect")),
    );
  });
  const read = inspectFile.pipe(
    Effect.andThen(bucket.get.pipe(Effect.mapError(() => transactionError("journal", "inspect")))),
    Effect.filterOrFail(
      (journal) => journal === null || journal.root === root,
      () => transactionError("journal", "inspect"),
    ),
    Effect.withSpan("ManagedFileJournal.read"),
  );
  const acquireLock = Effect.fn("ManagedFileJournal.acquireLock")(function* (phase: "prepare" | "recover") {
    const { lock } = yield* Effect.acquireRelease(
      acquireAdvisoryLockAt(join(dir, "transaction.lock"), "transaction", {
        expireLiveOwner: false,
        privateFileAccess,
      }).pipe(
        Effect.map((file) => ({ file, lock: new HeldTransactionLock(dir) })),
        Effect.mapError(() => transactionError("lock", phase)),
      ),
      ({ file, lock }) =>
        Effect.sync(() => HeldTransactionLock.release(lock)).pipe(Effect.andThen(file.release)),
    );
    return lock;
  });
  const write = Effect.fn("ManagedFileJournal.write")(function* (
    lock: TransactionLock,
    command: JournalCommand,
  ) {
    const phase = operationPhase[command.operation];
    if (!lock.holds(dir)) return yield* Effect.fail(transactionError("lock", phase));
    yield* inspectFile;
    const removed = yield* bucket
      .mutate((previous): Effect.Effect<StateWrite<Journal, boolean>, ManagedFileTransactionError> => {
        if (previous !== null && previous.root !== root)
          return Effect.fail(transactionError("journal", "inspect"));
        const verdict = journalTransitions.step(command.operation, previous?.state ?? "absent");
        switch (verdict._tag) {
          case "Settled":
            return Effect.succeed({ _tag: "Keep", result: false });
          case "Illegal":
            return Effect.fail(transactionError("journal", phase));
          case "Advance": {
            if (verdict.to === "absent") return Effect.succeed({ _tag: "Remove", result: true });
            const body = command.operation === "prepare" ? command.body : previous;
            if (body === null || body.root !== root) return Effect.fail(transactionError("journal", phase));
            return Effect.succeed({ _tag: "Set", value: { ...body, state: verdict.to }, result: false });
          }
          default:
            return verdict satisfies never;
        }
      })
      .pipe(
        Effect.mapError((error) =>
          error instanceof ManagedFileTransactionError
            ? error
            : transactionError("journal", error.operation === "get" ? "inspect" : phase),
        ),
      );
    if (removed) yield* transactionIO("cleanup", () => syncDirectory(dir));
  }, Effect.uninterruptible);
  return {
    directory: dir,
    path: bucket.path,
    read,
    acquireLock,
    prepare: (lock: TransactionLock, body: Omit<Journal, "state">) =>
      write(lock, { operation: "prepare", body }),
    beginCommit: (lock: TransactionLock) => write(lock, { operation: "begin-commit" }),
    finishCommit: (lock: TransactionLock) => write(lock, { operation: "finish-commit" }),
    block: (lock: TransactionLock) => write(lock, { operation: "block" }),
    removeCommitted: (lock: TransactionLock) => write(lock, { operation: "remove-committed" }),
  };
});
export type JournalStore = Effect.Success<ReturnType<typeof openJournal>>;
