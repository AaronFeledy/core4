import { Effect, Schema } from "effect";

export class ManagedFileTransactionError extends Schema.TaggedError<ManagedFileTransactionError>()(
  "ManagedFileTransactionError",
  {
    reason: Schema.Literal("path", "conflict", "io", "journal", "lock", "checkpoint"),
    phase: Schema.Literal("prepare", "commit", "inspect", "cleanup"),
    path: Schema.String.pipe(Schema.maxLength(4096)),
    cause: Schema.Literal("filesystem", "invariant", "interrupted-checkpoint"),
    remediation: Schema.String.pipe(Schema.maxLength(256)),
  },
) {}

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
    remediation: "Preserve the transaction journal and backups; inspect the recorded state before retrying.",
  });

export const transactionIO = <A>(phase: ManagedFileTransactionError["phase"], action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => (cause instanceof ManagedFileTransactionError ? cause : transactionError("io", phase)),
  });
