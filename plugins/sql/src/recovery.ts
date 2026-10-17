import { DateTime, Effect, Exit } from "effect";

import { SqlRecoveryOperationError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { SnapshotMetadata } from "@lando/sdk/schema";

import type { SqlPublisher } from "./progress.ts";
import { resolveLockedPhysicalTarget } from "./recovery-adoption.ts";
import {
  type SqlPhysicalContextInput,
  type SqlRecoveryContext,
  resolvePhysicalContext,
  resolvePhysicalTarget,
} from "./recovery-target.ts";
import { DEFAULT_SNAPSHOT_KEEP_LATEST } from "./snapshot-retention.ts";

export type { SqlRecoveryContext, SqlRecoveryDeps } from "./recovery-target.ts";

type SqlPhysicalOperation<A, E> = SqlPhysicalContextInput & {
  readonly reason: Exclude<SnapshotMetadata["recoveryReason"], "seed">;
  readonly resumeAfterSnapshot: boolean;
  readonly publish: SqlPublisher;
  readonly body: (context: SqlRecoveryContext, recoveryId: string) => Effect.Effect<A, E>;
};

export const withPhysicalVolumeLock = <A, E>(
  input: SqlPhysicalContextInput & {
    readonly body: (context: SqlRecoveryContext) => Effect.Effect<A, E>;
  },
) =>
  resolvePhysicalTarget(input).pipe(
    Effect.flatMap((target) =>
      input.deps.withVolumeLock(
        target.coordinationKey,
        resolvePhysicalTarget(input).pipe(
          Effect.flatMap((lockedTarget) => resolveLockedPhysicalTarget(input, target, lockedTarget)),
          Effect.flatMap((identifiedTarget) =>
            resolvePhysicalContext(input, identifiedTarget).pipe(
              Effect.flatMap((context) => Effect.suspend(() => input.body(context))),
            ),
          ),
        ),
      ),
    ),
  );

export const runPhysicalOperation = <A, E>(input: SqlPhysicalOperation<A, E>) =>
  withPhysicalVolumeLock({
    deps: input.deps,
    plan: input.plan,
    service: input.service,
    serviceName: input.serviceName,
    family: input.family,
    creds: input.creds,
    env: input.env,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
    adoptLegacy: true,
    body: Effect.fn("Sql.snapshot")(function* (context: SqlRecoveryContext) {
      if (input.preflight !== undefined) yield* input.preflight(context);
      if (context.running) yield* context.suspend;
      yield* context.verifyVolume;
      const recovery = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const captured = yield* restore(
            input.deps.snapshot(context.volume, {
              format: input.format ?? "tar.gz",
              ...(input.label === undefined ? {} : { label: input.label }),
              metadata: { ...context.metadata, recoveryReason: input.reason },
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(captured)) {
            if (context.running) yield* context.resume;
            return yield* Effect.failCause(captured.cause);
          }
          return captured.value;
        }),
      );
      if (input.resumeAfterSnapshot && context.running) yield* context.resume;
      const result = yield* input.body(context, recovery.id).pipe(
        Effect.mapError((cause) =>
          input.reason === "manual"
            ? cause
            : new SqlRecoveryOperationError({
                message: `${input.reason} failed after recovery snapshot ${recovery.id} was created.`,
                service: input.serviceName,
                operation: input.reason,
                recoverySnapshotId: recovery.id,
                cause,
                remediation: `Restore recovery snapshot ${recovery.id} after resolving the failure.`,
              }),
        ),
      );
      if (input.reason !== "manual") {
        yield* input.deps
          .pruneSnapshots({
            filter: {
              app: context.volume.app,
              store: context.volume.store,
              sourceRoot: context.metadata.sourceRoot,
              service: context.metadata.service,
              ...(context.metadata.ownerKey === undefined ? {} : { ownerKey: context.metadata.ownerKey }),
            },
            recovery: true,
            keepLatest: DEFAULT_SNAPSHOT_KEEP_LATEST,
            retainSnapshotId: recovery.id,
          })
          .pipe(
            Effect.catch(() =>
              DateTime.now.pipe(
                Effect.flatMap((timestamp) =>
                  input.publish(
                    MessageWarnEvent.make({
                      body: `Database ${input.serviceName} was updated, but older recovery snapshots could not be pruned. Lando retries after the next import, reset, or restore; run lando db:snapshots to see them.`,
                      timestamp,
                    }),
                  ),
                ),
                Effect.catch(() =>
                  Effect.logWarning("Could not publish recovery snapshot retention warning."),
                ),
              ),
            ),
          );
      }
      return result;
    }),
  });
