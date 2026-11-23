import { ManagedFileTransactionError, StateStoreError } from "@lando/sdk/errors";
import { Effect } from "effect";

export { ManagedFileTransactionError };

const BLOCKED_REMEDIATION =
  "Transaction blocked: a recorded file changed outside Lando. Compare each target against its .bak backup, resolve by hand, then remove the journal.";
const DEFAULT_REMEDIATION =
  "Preserve the transaction journal and backups; inspect the recorded state before retrying.";
export const HARDLINK_PUBLICATION_REMEDIATION =
  "Exclusive hardlink publish was refused. Lando will not rename over the target or copy partial bytes. Use a hardlink-capable filesystem.";
const PENDING_REMEDIATION =
  "Resolve the pending managed-file transaction with an ordinary load before retrying the candidate read.";

/** Transaction remediation is capped at 256 chars by the SDK schema. */
const clampRemediation = (text: string): string => (text.length <= 256 ? text : `${text.slice(0, 253)}...`);

export const transactionError = (
  reason: ManagedFileTransactionError["reason"],
  phase: ManagedFileTransactionError["phase"],
  path = "",
  remediation = reason === "blocked"
    ? BLOCKED_REMEDIATION
    : reason === "pending-transaction"
      ? PENDING_REMEDIATION
      : DEFAULT_REMEDIATION,
): ManagedFileTransactionError =>
  new ManagedFileTransactionError({
    reason,
    phase,
    path: path.slice(0, 4096),
    cause: reason === "io" ? "filesystem" : reason === "checkpoint" ? "interrupted-checkpoint" : "invariant",
    remediation: clampRemediation(remediation),
  });

/**
 * Map a store failure into a transaction error. A newer-version cause keeps the
 * store's upgrade remediation instead of the generic journal advice.
 */
export const storeAwareTransactionError = (
  reason: ManagedFileTransactionError["reason"],
  phase: ManagedFileTransactionError["phase"],
  cause: unknown,
  path = "",
): ManagedFileTransactionError => {
  if (cause instanceof StateStoreError && cause.reason === "newer-version") {
    return new ManagedFileTransactionError({
      reason,
      phase,
      path: (cause.path ?? path).slice(0, 4096),
      cause,
      remediation: `A newer Lando wrote this journal (envelope version ${cause.storedVersion}; this Lando supports ${cause.supportedVersion}). Run the newer Lando or upgrade Lando, and leave the file in place.`,
    });
  }
  if (cause instanceof StateStoreError && reason === "lock") {
    return transactionError(reason, phase, cause.path ?? path, cause.remediation);
  }
  return transactionError(reason, phase, path);
};

export const transactionIO = <A>(phase: ManagedFileTransactionError["phase"], action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => (cause instanceof ManagedFileTransactionError ? cause : transactionError("io", phase)),
  });
