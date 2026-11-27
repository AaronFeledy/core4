/**
 * Receipts for the host changes Lando made, so uninstall can undo exactly those changes and
 * nothing it cannot prove it made. One durable bucket under the user data root holds every
 * receipt; each write names its lifecycle operation, and the operation, not the caller, picks the
 * stored phase. A receipt starts when a change's first step runs, settles as `applied` when the
 * change took effect (in whole or in part), and goes away when no privileged step of a first
 * attempt succeeded or uninstall undid it. Changes with nothing to undo get no receipt.
 */
import { join } from "node:path";

import { mapFailures } from "@lando/sdk/command-result";
import { HostChangeFailedError, type StateStoreError } from "@lando/sdk/errors";
import {
  type HostChangeId,
  type HostChangeReceipt,
  type HostChangeReceiptPhase,
  HostChangeReceipts,
} from "@lando/sdk/schema";
import type { StateBucket, StateStoreShape, StateWrite } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage, planTransition } from "@lando/sdk/transitions";
import { Effect } from "effect";

export const HOST_CHANGE_RECEIPTS_VERSION = 1 as const;

/** The file the receipt bucket lives in: its namespace and key under the user data root. */
export const hostChangeReceiptsFile = (userDataRoot: string): string =>
  join(userDataRoot, "host-changes", "receipts");

/**
 * A record's state for one write: its phase, or `stale` for an `applying` record that another
 * attempt started. That attempt was interrupted after its first step may have changed the host, so
 * the record is the only trace of that change: no later attempt may drop it.
 */
export type HostChangeReceiptState = HostChangeReceiptPhase | "absent" | "stale";

/**
 * A rerun that applies a change Lando already recorded keeps that record: `begin-apply` is settled
 * there, `record-applied` refreshes it, and `abandon` leaves it. `abandon` drops only the record
 * its own attempt began; a stale one stays until a later run records the change applied or
 * uninstall undoes it. Setup after an interrupted undo `reclaim`s the record instead of starting
 * it over: the change may still be in place, so the record returns to `applied` with the facts
 * and undo it was recorded with, and this attempt then refreshes it or leaves it.
 */
export const hostChangeReceiptTransitions = defineTransitions<HostChangeReceiptState>()({
  "begin-apply": { from: ["absent"], to: "applying", settledIn: ["applying", "applied", "stale"] },
  reclaim: { from: ["undoing"], to: "applied" },
  "record-applied": { from: ["applying", "applied", "stale"], to: "applied" },
  abandon: { from: ["applying"], to: "absent", settledIn: ["absent", "applied", "stale"] },
  "begin-undo": { from: ["applying", "applied", "stale"], to: "undoing", settledIn: ["undoing"] },
  "undo-failed": { from: ["undoing"], to: "applied" },
  forget: { from: ["undoing"], to: "absent", settledIn: ["absent"] },
});

/** What an operation stores; `receipt` is the record an operation that writes one leaves behind. */
export type HostChangeReceiptWrite =
  | {
      readonly operation: "begin-apply" | "record-applied";
      /** Carries the writing attempt's `attempt`. */
      readonly receipt: Omit<HostChangeReceipt, "phase">;
    }
  | {
      readonly operation: "abandon";
      readonly id: HostChangeId;
      /** The attempt giving up; it drops the record only if it began it. */
      readonly attempt: string;
    }
  | {
      readonly operation: "begin-undo" | "undo-failed" | "forget";
      readonly id: HostChangeId;
    };

const writeAttempt = (write: HostChangeReceiptWrite): string | undefined =>
  "receipt" in write ? write.receipt.attempt : "attempt" in write ? write.attempt : undefined;

/** `applying` is this write's own attempt; any other attempt's `applying` record is stale. */
const receiptState = (
  previous: HostChangeReceipt | undefined,
  write: HostChangeReceiptWrite,
): HostChangeReceiptState => {
  if (previous === undefined) return "absent";
  if (previous.phase !== "applying") return previous.phase;
  const attempt = writeAttempt(write);
  return attempt !== undefined && previous.attempt === attempt ? "applying" : "stale";
};

const writeId = (write: HostChangeReceiptWrite): HostChangeId =>
  "receipt" in write ? write.receipt.id : write.id;

const receiptFailure = (id: string, message: string, remediation: string) =>
  new HostChangeFailedError({ changeId: id, message, remediation });

/** The table's operation for `write`: beginning to apply over an interrupted undo reclaims it. */
const tableOperation = (
  write: HostChangeReceiptWrite,
  state: HostChangeReceiptState,
): keyof typeof hostChangeReceiptTransitions.edges =>
  write.operation === "begin-apply" && state === "undoing" ? "reclaim" : write.operation;

/** Pure, so the durable store and test doubles apply the same table to one receipt. */
export const planHostChangeReceiptWrite = (
  previous: HostChangeReceipt | undefined,
  write: HostChangeReceiptWrite,
): Effect.Effect<StateWrite<HostChangeReceipt, void>, HostChangeFailedError> => {
  const from = receiptState(previous, write);
  const operation = tableOperation(write, from);
  const plan = planTransition(
    hostChangeReceiptTransitions,
    operation,
    from,
    (state): HostChangeReceipt | null => {
      // No operation enters `stale`; it only names another attempt's `applying` record.
      if (state === "absent" || state === "stale") return null;
      const record = "receipt" in write && operation !== "reclaim" ? write.receipt : previous;
      if (record === undefined) return null;
      // Only an `applying` record keeps the attempt that may drop it.
      const { attempt, ...rest } = record;
      return state === "applying" && attempt !== undefined
        ? { ...rest, attempt, phase: state }
        : { ...rest, phase: state };
    },
  );
  switch (plan._tag) {
    case "Keep":
      return Effect.succeed({ _tag: "Keep", result: undefined });
    case "Write":
      return Effect.succeed(
        plan.value === null
          ? { _tag: "Remove", result: undefined }
          : { _tag: "Set", value: plan.value, result: undefined },
      );
    case "Illegal":
      return Effect.fail(
        receiptFailure(
          writeId(write),
          illegalTransitionMessage(`Lando's record of ${writeId(write)}`, write.operation, plan.verdict),
          "Run `lando uninstall --dry-run` to see the host changes Lando recorded, then rerun the command.",
        ),
      );
  }
};

export interface HostChangeReceiptStore {
  readonly list: Effect.Effect<ReadonlyArray<HostChangeReceipt>, HostChangeFailedError>;
  readonly write: (write: HostChangeReceiptWrite) => Effect.Effect<void, HostChangeFailedError>;
}

const storeFailure = (id: HostChangeId | "receipts") => (cause: StateStoreError) =>
  receiptFailure(
    id === "receipts" ? "host-change:receipts" : id,
    `Lando could not ${id === "receipts" ? "read" : "record"} its host-change receipts: ${cause.message}`,
    cause.remediation,
  );

const openBucket = (
  store: StateStoreShape,
): Effect.Effect<StateBucket<ReadonlyArray<HostChangeReceipt>>, StateStoreError> =>
  store.open({
    root: "userData",
    namespace: "host-changes",
    key: "receipts",
    schema: HostChangeReceipts,
    version: HOST_CHANGE_RECEIPTS_VERSION,
    mode: 0o600,
    codec: "json",
    lock: "advisory",
    onCorrupt: "fail",
    default: [],
  });

const sortById = (receipts: ReadonlyArray<HostChangeReceipt>) =>
  [...receipts].sort((left, right) => left.id.localeCompare(right.id));

export const makeHostChangeReceiptStore = (store: StateStoreShape): HostChangeReceiptStore => ({
  list: openBucket(store).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((receipts) => receipts ?? []),
    mapFailures(storeFailure("receipts")),
  ),
  write: (write) => {
    const id = writeId(write);
    return openBucket(store).pipe(
      Effect.flatMap((bucket) =>
        bucket.mutate((current) => {
          const receipts = current ?? [];
          return planHostChangeReceiptWrite(
            receipts.find((receipt) => receipt.id === id),
            write,
          ).pipe(
            Effect.map((plan): StateWrite<ReadonlyArray<HostChangeReceipt>, void> => {
              const others = receipts.filter((receipt) => receipt.id !== id);
              switch (plan._tag) {
                case "Keep":
                  return plan;
                case "Remove":
                  return others.length === 0
                    ? { _tag: "Remove", result: undefined }
                    : { _tag: "Set", value: others, result: undefined };
                case "Set":
                  return { _tag: "Set", value: sortById([...others, plan.value]), result: undefined };
                default: {
                  const exhaustive: never = plan;
                  return exhaustive;
                }
              }
            }),
          );
        }),
      ),
      mapFailures((cause) => (cause._tag === "StateStoreError" ? storeFailure(id)(cause) : cause)),
    );
  },
});
