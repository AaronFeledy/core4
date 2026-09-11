import { join } from "node:path";
import type { ManagedFileTransactionPendingReport } from "@lando/sdk/services";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { type PrivateFileAccess, PrivateFileAccessError } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type ManagedFileTransactionError, transactionError, transactionIO } from "./transaction-error.ts";
import { canonicalRoot, finishAppliedMode, mutateEntry, removeRecordedStage } from "./transaction-fs.ts";
import { type Journal, journalDirectory, openJournal } from "./transaction-journal.ts";
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

type JournalStore = Effect.Effect.Success<ReturnType<typeof openJournal>>;

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

  const locate = (appRoot: string, createDirectory: boolean) =>
    Effect.gen(function* () {
      const root = yield* transactionIO("recover", () => canonicalRoot(appRoot));
      const dir = journalDirectory(root, options.journalRoot());
      const store = yield* openJournal(root, dir, {
        createDirectory,
        privateFileAccess: options.privateFileAccess,
      });
      return { root, dir, store };
    });

  /** Read-only dry run. Acquires no lock and creates, mutates, or removes nothing. */
  const pending = (
    appRoot: string,
  ): Effect.Effect<ManagedFileTransactionPendingReport | null, ManagedFileTransactionError> =>
    Effect.gen(function* () {
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

  const rollForward = (root: string, journal: Journal, store: JournalStore) =>
    Effect.gen(function* () {
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
      if (journal.state === "prepared") yield* store.write({ ...journal, state: "committing" });
      yield* checkpoint("recovering");
      for (const [index, { entry, disposition }] of classified.entries()) {
        if (disposition === "pending")
          yield* transactionIO("recover", () => mutateEntry(root, entry, options.privateFileAccess)).pipe(
            Effect.uninterruptible,
          );
        else if (disposition === "applied-needs-mode")
          yield* transactionIO("recover", () =>
            finishAppliedMode(root, entry, options.privateFileAccess),
          ).pipe(Effect.uninterruptible);
        yield* checkpoint("after-recovery-mutation", index);
      }
      yield* store.write({ ...journal, state: "committed" });
      yield* checkpoint("recovered");
    });

  const recover = (appRoot: string) =>
    Effect.gen(function* () {
      const { root, dir, store } = yield* locate(appRoot, true);
      yield* Effect.acquireRelease(
        acquireAdvisoryLockAt(join(dir, "transaction.lock"), "transaction", {
          expireLiveOwner: false,
          privateFileAccess: options.privateFileAccess,
        }).pipe(Effect.mapError(() => transactionError("lock", "recover"))),
        (lock) => lock.release,
      );
      const journal = yield* store.read;
      if (journal === null) return null;
      if (journal.state === "blocked") return yield* Effect.fail(transactionError("blocked", "recover"));
      if (journal.state === "committed") {
        yield* cleanupStages(journal);
        yield* store.removeCommitted;
        return { id: journal.id, action: "cleaned" } satisfies RecoveryOutcome;
      }
      yield* rollForward(root, journal, store).pipe(
        Effect.catchIf(
          (error) => blocking.has(error.reason),
          (error) =>
            store.block.pipe(
              Effect.zipRight(Effect.fail(transactionError("blocked", "recover", error.path))),
            ),
        ),
      );
      yield* cleanupStages(journal);
      yield* store.removeCommitted;
      return { id: journal.id, action: "recovered" } satisfies RecoveryOutcome;
    });

  /**
   * The guard entry point. It peeks without creating or locking anything, so the
   * common no-transaction path costs two stats, and only escalates to the
   * canonical-root lock when a journal actually exists.
   */
  const ensureConsistent = (appRoot: string): Effect.Effect<void, ManagedFileTransactionError> =>
    pending(appRoot).pipe(
      Effect.flatMap((report) =>
        report === null ? Effect.void : Effect.scoped(recover(appRoot)).pipe(Effect.asVoid),
      ),
    );

  return { recover, pending, ensureConsistent };
};
