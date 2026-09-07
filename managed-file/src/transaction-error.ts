import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { Effect } from "effect";

export { ManagedFileTransactionError };

const BLOCKED_REMEDIATION =
  "Transaction blocked: a recorded file changed outside Lando. Compare each target against its .bak backup, resolve by hand, then remove the journal.";
const DEFAULT_REMEDIATION =
  "Preserve the transaction journal and backups; inspect the recorded state before retrying.";

export const transactionError = (
  reason: ManagedFileTransactionError["reason"],
  phase: ManagedFileTransactionError["phase"],
  path = "",
): ManagedFileTransactionError =>
  new ManagedFileTransactionError({
    reason,
    phase,
    path: path.slice(0, 4096),
    cause: reason === "io" ? "filesystem" : reason === "checkpoint" ? "interrupted-checkpoint" : "invariant",
    remediation: reason === "blocked" ? BLOCKED_REMEDIATION : DEFAULT_REMEDIATION,
  });

export const transactionIO = <A>(phase: ManagedFileTransactionError["phase"], action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => (cause instanceof ManagedFileTransactionError ? cause : transactionError("io", phase)),
  });
