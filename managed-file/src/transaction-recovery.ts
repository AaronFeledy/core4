import { lstat } from "node:fs/promises";
import type { ManagedFileTransactionPendingReport } from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessError } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { finishLinkedCreate, publishCreate } from "./transaction-create-link.ts";
import { ensureDirectoryPolicy } from "./transaction-create-path.ts";
import { type ManagedFileTransactionError, transactionError, transactionIO } from "./transaction-error.ts";
import { canonicalRoot, finishAppliedMode, mutateEntry, removeRecordedStage } from "./transaction-fs.ts";
import { type Journal, type JournalStore, type TransactionLock, openJournal } from "./transaction-journal.ts";
import { preflight } from "./transaction-preflight.ts";

export type RecoveryAction = "recovered" | "cleaned";
export interface RecoveryOutcome {
  readonly id: string;
  readonly action: RecoveryAction;
}
export interface RecoveryOptions {
  readonly journalRoot: () => string;
  readonly checkpoint?: (point: string, index: number) => Effect.Effect<void, ManagedFileTransactionError>;
  readonly privateFileAccess: PrivateFileAccess;
}

const blocking = new Set<ManagedFileTransactionError["reason"]>(["conflict", "path"]);

const reportAction = (state: Journal["state"]): ManagedFileTransactionPendingReport["action"] =>
  state === "blocked" ? "manual-resolution" : state === "committed" ? "cleanup" : "recover";

/**
 * Recovery and read-only inspection for the app-root transaction journal.
 *
 * Recovery only ever rolls forward. The journal has durable backups and stages,
 * every mutation is conditional on the recorded before-state plus an immediate
 * digest recheck, and a conflict marks the journal `blocked` instead of writing
 * over a file somebody else changed.
 */
export const makeTransactionRecovery = (options: RecoveryOptions) => {
  const checkpoint = (point: string, index = -1) =>
    options.checkpoint === undefined ? Effect.void : options.checkpoint(point, index);

  const locate = Effect.fnUntraced(function* (appRoot: string, createDirectory: boolean) {
    const root = yield* transactionIO("recover", () => canonicalRoot(appRoot));
    const store = yield* openJournal(root, options.journalRoot(), {
      createDirectory,
      privateFileAccess: options.privateFileAccess,
    });
    return { root, store };
  });

  // A root that does not exist yet (the global app before its first write) holds no transaction.
  const rootExists = (appRoot: string) =>
    transactionIO("inspect", () =>
      lstat(appRoot).then(
        () => true,
        (cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
          throw cause;
        },
      ),
    );

  /** Read-only dry run. Acquires no lock and creates, mutates, or removes nothing. */
  const pending = Effect.fn("ManagedFileTransactionGuard.pending")(function* (
    appRoot: string,
  ): Effect.fn.Return<ManagedFileTransactionPendingReport | null, ManagedFileTransactionError> {
    if (!(yield* rootExists(appRoot))) return null;
    const { store } = yield* locate(appRoot, false);
    const journal = yield* store.read;
    if (journal === null) return null;
    return {
      id: journal.id,
      state: journal.state,
      action: reportAction(journal.state),
      targets: [...journal.entries.map((entry) => entry.path)].sort(),
    };
  });

  const cleanupStages = (journal: Journal) =>
    transactionIO("cleanup", async () => {
      for (const entry of journal.entries)
        if (entry.stage !== undefined && entry.after.present)
          await removeRecordedStage(entry.stage, entry.after.digest, options.privateFileAccess);
    }).pipe(Effect.uninterruptible);

  const rollForward = Effect.fn("ManagedFileTransactions.rollForward")(function* (
    root: string,
    journal: Journal,
    store: JournalStore,
    lock: TransactionLock,
  ) {
    yield* store.beginCommit(lock);
    yield* checkpoint("recovering");
    yield* transactionIO("recover", () => ensureDirectoryPolicy(root, journal.directoryPolicy, "recover"));
    const classified = yield* transactionIO("recover", async () => {
      try {
        return await preflight(root, journal, options.privateFileAccess);
      } catch (cause) {
        if (cause instanceof PrivateFileAccessError) {
          throw transactionError("conflict", "recover");
        }
        throw cause;
      }
    });
    for (const [index, { entry, disposition }] of classified.entries()) {
      if (disposition === "pending" && entry.publication === "create")
        yield* transactionIO("recover", () =>
          publishCreate({ root, entry, privateFileAccess: options.privateFileAccess, phase: "recover" }),
        ).pipe(Effect.uninterruptible);
      else if (disposition === "pending")
        yield* transactionIO("recover", () => mutateEntry(root, entry, options.privateFileAccess)).pipe(
          Effect.uninterruptible,
        );
      else if (disposition === "applied-needs-mode")
        yield* transactionIO("recover", () => finishAppliedMode(root, entry, options.privateFileAccess)).pipe(
          Effect.uninterruptible,
        );
      else if (disposition === "linked")
        yield* transactionIO("recover", () => finishLinkedCreate(root, entry)).pipe(Effect.uninterruptible);
      yield* checkpoint("after-recovery-mutation", index);
    }
    yield* store.finishCommit(lock);
    yield* checkpoint("recovered");
  });

  const recover = Effect.fn("ManagedFileTransactions.recover")(function* (appRoot: string) {
    const { root, store } = yield* locate(appRoot, true);
    const lock = yield* store.acquireLock("recover");
    const journal = yield* store.read;
    if (journal === null) return null;
    if (journal.state === "blocked") return yield* Effect.fail(transactionError("blocked", "recover"));
    if (journal.state === "committed") {
      yield* cleanupStages(journal);
      yield* store.removeCommitted(lock);
      return { id: journal.id, action: "cleaned" } satisfies RecoveryOutcome;
    }
    yield* rollForward(root, journal, store, lock).pipe(
      Effect.catchIf(
        (error) => blocking.has(error.reason),
        (error) =>
          store
            .block(lock)
            .pipe(Effect.andThen(Effect.fail(transactionError("blocked", "recover", error.path)))),
      ),
    );
    yield* cleanupStages(journal);
    yield* store.removeCommitted(lock);
    return { id: journal.id, action: "recovered" } satisfies RecoveryOutcome;
  });

  /**
   * The guard entry point. It peeks without creating or locking anything, so the
   * common no-transaction path costs two stats, and only escalates to the
   * canonical-root lock when a journal actually exists.
   */
  const ensureConsistent = Effect.fn("ManagedFileTransactionGuard.ensureConsistent")(
    (appRoot: string): Effect.Effect<void, ManagedFileTransactionError> =>
      pending(appRoot).pipe(
        Effect.flatMap((report) =>
          report === null ? Effect.void : Effect.scoped(recover(appRoot)).pipe(Effect.asVoid),
        ),
      ),
  );

  return { recover, pending, ensureConsistent };
};
