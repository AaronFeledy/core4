import { Effect } from "effect";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { SnapshotInfo } from "@lando/sdk/schema";

import type { SqlRecoveryContext } from "./recovery.ts";

export const requireSeedCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  context: SqlRecoveryContext,
): Effect.Effect<void, SqlRecoveryUnavailableError> => {
  const metadata = source?.metadata;
  return metadata !== undefined &&
    metadata.family === context.metadata.family &&
    metadata.version === context.metadata.version &&
    metadata.imageIdentity === context.metadata.imageIdentity &&
    metadata.ownerKey === context.metadata.ownerKey &&
    metadata.service === context.metadata.service &&
    metadata.sourceRoot === context.metadata.sourceRoot
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Snapshot ${source?.id ?? "(missing)"} is not physically compatible with ${context.metadata.service}.`,
          service: context.metadata.service,
          reason: "Snapshot ownership, service, family, version, or image does not match.",
          remediation: "Use a matching physical snapshot or move data with logical export and import.",
        }),
      );
};

export const requireRestoreCompatibleSnapshot = (
  source: SnapshotInfo | undefined,
  context: SqlRecoveryContext,
) =>
  requireSeedCompatibleSnapshot(source, context).pipe(
    Effect.andThen(() =>
      source?.metadata?.volumeInstanceId === context.metadata.volumeInstanceId
        ? Effect.void
        : Effect.fail(
            new SqlRecoveryUnavailableError({
              message: `Snapshot ${source?.id ?? "(missing)"} is not physically compatible with ${context.metadata.service}.`,
              service: context.metadata.service,
              reason: "Snapshot physical volume identity does not match.",
              remediation:
                "Restore only to the original physical volume instance, or seed a fresh volume of the same app and service.",
            }),
          ),
    ),
  );
