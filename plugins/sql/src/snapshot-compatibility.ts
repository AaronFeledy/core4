import { Effect } from "effect";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { SnapshotInfo } from "@lando/sdk/schema";

import type { SqlRecoveryContext } from "./recovery.ts";

export const requireCompatibleSnapshot = (source: SnapshotInfo | undefined, context: SqlRecoveryContext) => {
  const metadata = source?.metadata;
  return metadata !== undefined &&
    metadata.family === context.metadata.family &&
    metadata.version === context.metadata.version &&
    metadata.imageIdentity === context.metadata.imageIdentity &&
    metadata.volumeInstanceId === context.metadata.volumeInstanceId &&
    metadata.ownerKey === context.metadata.ownerKey &&
    metadata.service === context.metadata.service &&
    metadata.sourceRoot === context.metadata.sourceRoot
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Snapshot ${source?.id ?? "(missing)"} is not physically compatible with ${context.metadata.service}.`,
          service: context.metadata.service,
          reason: "Snapshot ownership, family, version, image, or physical volume identity does not match.",
          remediation: "Use a matching physical snapshot or move data with logical export and import.",
        }),
      );
};
