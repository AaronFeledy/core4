import { resolve } from "node:path";

import { Effect } from "effect";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { type AbsolutePath, AppId, ServiceName, type SnapshotFilter } from "@lando/sdk/schema";

type SnapshotSourceInput = {
  readonly app: string;
  readonly store?: string;
  readonly ownerKey?: string;
  readonly repoGroupKey?: string;
  readonly service: string;
  readonly fromApp?: string;
  readonly fromPath?: string;
  readonly hostCwd: string;
  readonly canonicalizePath: (path: string) => Effect.Effect<AbsolutePath, SqlRecoveryUnavailableError>;
};

export const resolveSnapshotSource = (
  input: SnapshotSourceInput,
): Effect.Effect<SnapshotFilter, SqlRecoveryUnavailableError> => {
  if (input.fromApp !== undefined && input.fromPath !== undefined) {
    return Effect.fail(
      new SqlRecoveryUnavailableError({
        message: "Snapshot listing accepts only one explicit source selector.",
        service: input.service,
        reason: "Both --from-app and --from-path were provided.",
        remediation: "Pass either --from-app or --from-path, not both.",
      }),
    );
  }
  if (input.fromApp !== undefined) {
    if (input.repoGroupKey === undefined) {
      return Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Cannot establish repository ownership for snapshot source ${input.fromApp}.`,
          service: input.service,
          reason: "The current app has no Git repository group identity.",
          remediation: "Select the exact source app root with --from-path.",
        }),
      );
    }
    return Effect.succeed({
      app: AppId.make(input.fromApp),
      service: ServiceName.make(input.service),
      repoGroupKey: input.repoGroupKey,
    });
  }
  if (input.fromPath !== undefined) {
    return input
      .canonicalizePath(resolve(input.hostCwd, input.fromPath))
      .pipe(Effect.map((sourceRoot) => ({ sourceRoot, service: ServiceName.make(input.service) })));
  }
  return Effect.succeed({
    app: AppId.make(input.app),
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.ownerKey === undefined ? {} : { ownerKey: input.ownerKey }),
  });
};
