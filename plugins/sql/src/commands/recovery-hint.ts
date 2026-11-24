import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";
import { Effect } from "effect";

import type { DbCommandResult } from "../schemas.ts";

/** Names the snapshot a restore used and the undo point an import, reset, or restore saved. */
export const renderRecoveryHint = (result: DbCommandResult): string =>
  [
    ...(result.snapshotId === undefined ? [] : [`Restored snapshot ${result.snapshotId}.`]),
    ...(result.recoverySnapshotId === undefined
      ? []
      : [
          `Saved recovery snapshot ${result.recoverySnapshotId}. To undo, run: lando db:restore ${result.recoverySnapshotId} --service ${result.service} --yes`,
        ]),
  ].join("\n");

export const render: NonNullable<ExecutableCommandSpec<DbCommandResult>["render"]> = ({ result }) => {
  const text = renderRecoveryHint(result);
  return text === ""
    ? Effect.void
    : Renderer.pipe(Effect.flatMap((renderer) => renderer.output.stdout(`${text}\n`)));
};
