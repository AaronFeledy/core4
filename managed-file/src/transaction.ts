import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { acquireAdvisoryLockAt } from "@lando/state-store/lock";
import { Effect, Schema } from "effect";
import { ManagedFileTransactionError, transactionError, transactionIO } from "./transaction-error.ts";
import {
  canonicalRoot,
  createStage,
  ensureBackup,
  mutateEntry,
  removeOwnedStage,
  verifyBackup,
  verifyState,
} from "./transaction-fs.ts";
import {
  type Entry,
  type Journal,
  type Stage,
  journalDirectory,
  openJournal,
} from "./transaction-journal.ts";
import { TransactionRequest, planTransaction } from "./transaction-plan.ts";

export { ManagedFileTransactionError, TransactionRequest };
export type { Journal } from "./transaction-journal.ts";
export interface PreparedTransaction {
  readonly id: string;
  readonly journalPath: string;
}
export type TransactionCheckpoint =
  | "stage-created"
  | "prepared"
  | "committing"
  | "after-mutation"
  | "committed";
export interface TransactionOptions {
  readonly journalRoot: () => string;
  readonly checkpoint?: (point: TransactionCheckpoint, index: number) => Effect.Effect<void, unknown>;
}

export const makeManagedFileTransactions = (options: TransactionOptions) => {
  const leases = new WeakMap<
    PreparedTransaction,
    { readonly journal: Journal; readonly store: Effect.Effect.Success<ReturnType<typeof openJournal>> }
  >();
  const checkpoint = (point: TransactionCheckpoint, index = -1) =>
    Effect.suspend(() => options.checkpoint?.(point, index) ?? Effect.void).pipe(
      Effect.catchAllCause(() =>
        Effect.fail(
          transactionError(
            "checkpoint",
            point === "stage-created" || point === "prepared" ? "prepare" : "commit",
          ),
        ),
      ),
    );

  const prepare = (input: TransactionRequest) =>
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknown(TransactionRequest)(input).pipe(
        Effect.mapError(() => transactionError("path", "prepare")),
      );
      const root = yield* transactionIO("prepare", () => canonicalRoot(request.appRoot));
      const dir = journalDirectory(root, options.journalRoot());
      const store = yield* openJournal(root, dir);
      yield* Effect.acquireRelease(
        acquireAdvisoryLockAt(join(dir, "transaction.lock"), "transaction", { expireLiveOwner: false }).pipe(
          Effect.mapError(() => transactionError("lock", "prepare")),
        ),
        (lock) => lock.release,
      );
      if ((yield* store.read) !== null) return yield* Effect.fail(transactionError("journal", "prepare"));
      const id = randomUUID();
      const plans = yield* transactionIO("prepare", () => planTransaction(root, request, id));
      const stages: Stage[] = [];
      let retained = false;
      const prepared: PreparedTransaction = Object.freeze({ id, journalPath: store.path });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          leases.delete(prepared);
          if (retained) return;
          const journal = yield* store.read;
          if (journal?.id === id) return;
          yield* transactionIO("cleanup", async () => {
            for (const stage of stages) await removeOwnedStage(stage);
          });
        }).pipe(Effect.orDie),
      );
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          for (const plan of plans) {
            const before = plan.entry.before;
            if (before.present)
              yield* transactionIO("prepare", () =>
                ensureBackup(resolve(root, before.backup), plan.beforeBytes),
              );
          }
          const entries: Entry[] = [];
          for (const [index, plan] of plans.entries()) {
            if (plan.entry.after.present) {
              let created: Stage | undefined;
              yield* transactionIO("prepare", () =>
                createStage(
                  `${resolve(root, plan.entry.path)}.lando-stage.${id}`,
                  plan.afterBytes,
                  (stage) => {
                    stages.push(stage);
                    created = stage;
                  },
                ),
              );
              entries.push({ ...plan.entry, stage: created });
              yield* checkpoint("stage-created", index);
            } else entries.push(plan.entry);
          }
          const journal: Journal = { id, root, state: "prepared", entries };
          yield* store.write(journal);
          retained = true;
          leases.set(prepared, { journal, store });
          yield* checkpoint("prepared");
          return prepared;
        }),
      );
    });

  const commit = (prepared: PreparedTransaction) =>
    Effect.gen(function* () {
      const lease = leases.get(prepared);
      if (lease === undefined) return yield* Effect.fail(transactionError("journal", "commit"));
      const { journal, store } = lease;
      leases.delete(prepared);
      const current = yield* store.read;
      if (JSON.stringify(current) !== JSON.stringify(journal))
        return yield* Effect.fail(transactionError("journal", "commit"));
      for (const entry of journal.entries) {
        yield* transactionIO("commit", () => verifyState(journal.root, entry, entry.before));
        yield* transactionIO("commit", () => verifyBackup(journal.root, entry));
      }
      yield* store.write({ ...journal, state: "committing" });
      yield* checkpoint("committing");
      for (const [index, entry] of journal.entries.entries()) {
        yield* transactionIO("commit", () => mutateEntry(journal.root, entry)).pipe(Effect.uninterruptible);
        yield* checkpoint("after-mutation", index);
      }
      yield* store.write({ ...journal, state: "committed" });
      yield* checkpoint("committed");
      yield* transactionIO("cleanup", async () => {
        for (const entry of journal.entries)
          if (entry.stage !== undefined) await removeOwnedStage(entry.stage);
      }).pipe(Effect.uninterruptible);
      yield* store.removeCommitted;
      return {
        id: journal.id,
        written: journal.entries
          .filter((entry) => entry.after.present)
          .map((entry) => entry.path)
          .sort(),
        removed: journal.entries
          .filter((entry) => !entry.after.present)
          .map((entry) => entry.path)
          .sort(),
        backups: journal.entries.flatMap((entry) => (entry.before.present ? [entry.before.backup] : [])),
      };
    });
  const readJournal = (appRoot: string) =>
    Effect.gen(function* () {
      const root = yield* transactionIO("inspect", () => canonicalRoot(appRoot));
      const store = yield* openJournal(root, journalDirectory(root, options.journalRoot()));
      return yield* store.read;
    });
  return {
    prepare,
    commit,
    readJournal,
    run: (request: TransactionRequest) => Effect.scoped(prepare(request).pipe(Effect.flatMap(commit))),
  };
};
