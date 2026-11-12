import {
  SqlCommandFailedError,
  SqlRecoveryOperationError,
  SqlRecoveryUnavailableError,
} from "@lando/sdk/errors";
import type { SqlFileTarget } from "./target.ts";

export const sqliteRecoveryFailure = (
  cause: unknown,
  target: SqlFileTarget,
  recovery: {
    readonly operation: "reset" | "import" | "restore";
    readonly file: string;
    readonly snapshotId?: string;
    /** The mutation committed and verified; only resuming the service failed afterward. */
    readonly completed?: boolean;
  },
) => {
  if (recovery.completed === true && recovery.snapshotId !== undefined) {
    return new SqlRecoveryOperationError({
      message: `${recovery.operation} completed for ${target.path} on ${target.name}, but the service did not resume. Recovery ID: ${recovery.snapshotId}.`,
      service: target.name,
      operation: recovery.operation,
      recoverySnapshotId: recovery.snapshotId,
      cause,
      remediation: `Run lando start to bring ${target.name} back; do not retry the ${recovery.operation}. Recovery ${recovery.snapshotId} still holds the previous ${target.path} if you need to undo it.`,
    });
  }
  const file =
    cause instanceof SqlRecoveryUnavailableError ? (cause.recoveryFile ?? recovery.file) : recovery.file;
  const remediation =
    recovery.snapshotId === undefined
      ? `Preserve recovery file ${file}, which contains ${target.path} on ${target.name}. Recovery was captured but not catalogued.`
      : `Recovery ${recovery.snapshotId} covers only ${target.path} on ${target.name}. Restore with lando db:restore ${recovery.snapshotId} --service ${target.name}.`;
  return cause instanceof SqlCommandFailedError
    ? new SqlCommandFailedError({
        message: cause.message,
        service: cause.service,
        command: cause.command,
        ...(cause.exitCode === undefined ? {} : { exitCode: cause.exitCode }),
        ...(cause.reason === undefined ? {} : { reason: cause.reason }),
        ...(cause.stderrTail === undefined ? {} : { stderrTail: cause.stderrTail }),
        ...(recovery.snapshotId === undefined ? {} : { recoverySnapshotId: recovery.snapshotId }),
        remediation: `${cause.remediation} ${remediation}`,
      })
    : recovery.snapshotId === undefined
      ? new SqlRecoveryUnavailableError({
          message: `${recovery.operation} failed after SQLite recovery capture.`,
          service: target.name,
          reason: String(cause),
          recoveryFile: file,
          remediation,
        })
      : new SqlRecoveryOperationError({
          message: `${recovery.operation} did not complete successfully for ${target.path} on ${target.name}. Recovery ID: ${recovery.snapshotId}.`,
          service: target.name,
          operation: recovery.operation,
          recoverySnapshotId: recovery.snapshotId,
          cause,
          remediation,
        });
};
