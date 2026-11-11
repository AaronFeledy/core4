import { resolve } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  type AbsolutePath,
  AppId,
  ServiceName,
  type SnapshotFilter,
  appIdentityKey,
  planDataId,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import type { SqlCommandDeps } from "./command-types.ts";
import { type SqlPlan, sqlPlanDataId } from "./views.ts";

type SnapshotSourceInput = {
  readonly plan: SqlPlan;
  readonly appliedPlans?: SqlCommandDeps["appliedPlans"];
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
    const fromApp = input.fromApp;
    const repoGroupKey = input.repoGroupKey;
    return Effect.gen(function* () {
      const plans =
        fromApp === input.plan.id || input.appliedPlans === undefined
          ? []
          : yield* input.appliedPlans.pipe(
              mapFailures(
                (cause) =>
                  new SqlRecoveryUnavailableError({
                    message: `Cannot resolve snapshot source ${fromApp}.`,
                    service: input.service,
                    reason: cause.message,
                    remediation: "Select the exact source app root with --from-path.",
                  }),
              ),
            );
      const source = plans.find((plan) => plan.id === fromApp);
      return {
        app:
          fromApp === input.plan.id
            ? sqlPlanDataId(input.plan)
            : source === undefined
              ? AppId.make(fromApp)
              : planDataId(source),
        service: ServiceName.make(input.service),
        repoGroupKey,
      };
    });
  }
  if (input.fromPath !== undefined) {
    return input.canonicalizePath(resolve(input.hostCwd, input.fromPath)).pipe(
      Effect.map((sourceRoot) => ({
        ownerKey: appIdentityKey("owner", sourceRoot),
        service: ServiceName.make(input.service),
      })),
    );
  }
  return Effect.succeed({
    app: sqlPlanDataId(input.plan),
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.ownerKey === undefined ? {} : { ownerKey: input.ownerKey }),
  });
};
