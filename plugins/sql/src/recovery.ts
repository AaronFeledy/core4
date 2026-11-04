import { DateTime, Effect, Exit, Option, absurd } from "effect";

import { DataTransferError, SqlCommandFailedError, SqlRecoveryOperationError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { SnapshotId, type SnapshotMetadata } from "@lando/sdk/schema";

import { normalizeCommandFailure } from "./command-failure.ts";
import { SqlEnvironmentSession } from "./environment.ts";
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
  /** Snapshots retention must keep besides the one this operation takes, such as a restore source. */
  readonly retainSnapshotIds?: ReadonlyArray<string>;
  readonly body: (context: SqlRecoveryContext, recoveryId: string) => Effect.Effect<A, E>;
};

export const withPhysicalVolumeLock = Effect.fnUntraced(function* <A, E>(
  input: SqlPhysicalContextInput & {
    readonly body: (context: SqlRecoveryContext) => Effect.Effect<A, E>;
  },
) {
  const session = yield* SqlEnvironmentSession;
  return yield* resolvePhysicalTarget(input).pipe(
    Effect.flatMap((target) =>
      input.deps.withVolumeLock(
        target.coordinationKey,
        resolvePhysicalTarget(input)
          .pipe(
            Effect.flatMap((lockedTarget) => resolveLockedPhysicalTarget(input, target, lockedTarget)),
            Effect.flatMap((identifiedTarget) =>
              resolvePhysicalContext(input, identifiedTarget).pipe(
                Effect.flatMap((context) => Effect.suspend(() => input.body(context))),
              ),
            ),
          )
          .pipe(Effect.provideService(SqlEnvironmentSession, session)),
      ),
    ),
  );
});

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
              ...(context.owner.repoGroupKey === undefined
                ? {}
                : { repoGroupKey: context.owner.repoGroupKey }),
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
      const result = yield* Effect.gen(function* () {
        if (input.resumeAfterSnapshot && context.running) yield* context.resume;
        return yield* input.body(context, recovery.id);
      }).pipe(
        Effect.mapError((cause) => {
          const normalized = normalizeCommandFailure(cause);
          if (Option.isSome(normalized)) {
            const failure = normalized.value;
            switch (failure._tag) {
              case "SqlCommandFailedError":
                return new SqlCommandFailedError({
                  message: failure.message,
                  service: failure.service,
                  command: failure.command,
                  exitCode: failure.exitCode,
                  reason: failure.reason,
                  stderrTail: failure.stderrTail,
                  recoverySnapshotId: recovery.id,
                  remediation: `${failure.remediation} Use lando db:restore ${recovery.id} after resolving the failure if recovery is needed.`,
                });
              case "DataTransferError":
                return new DataTransferError({
                  message: failure.message,
                  fromEndpoint: failure.fromEndpoint,
                  toEndpoint: failure.toEndpoint,
                  operation: failure.operation,
                  exitCode: failure.exitCode,
                  reason: failure.reason,
                  stderrTail: failure.stderrTail,
                  recoverySnapshotId: recovery.id,
                  remediation: `${failure.remediation ?? "Resolve the command failure."} Use lando db:restore ${recovery.id} after resolving the failure if recovery is needed.`,
                });
              default:
                return absurd(failure);
            }
          }
          return new SqlRecoveryOperationError({
            message:
              input.reason === "manual"
                ? `Snapshot ${recovery.id} was captured, but ${input.serviceName} could not resume.`
                : `${input.reason} failed after recovery snapshot ${recovery.id} was created.`,
            service: input.serviceName,
            operation: input.reason === "manual" ? "snapshot" : input.reason,
            recoverySnapshotId: recovery.id,
            cause,
            remediation:
              input.reason === "manual"
                ? `Snapshot ${recovery.id} remains available. Resolve the database restart failure and start the service again.`
                : `Resolve the failure, then retry or restore recovery snapshot ${recovery.id} if needed.`,
          });
        }),
      );
      if (input.reason !== "manual") {
        yield* input.deps
          .pruneSnapshots({
            filter: {
              app: context.volume.app,
              store: context.volume.store,
              ownerKey: context.owner.ownerKey,
              service: context.metadata.service,
            },
            recovery: true,
            keepLatest: DEFAULT_SNAPSHOT_KEEP_LATEST,
            retainSnapshotIds: [recovery.id, ...(input.retainSnapshotIds ?? [])].map((id) =>
              SnapshotId.make(id),
            ),
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
      return { result, recoverySnapshotId: recovery.id };
    }),
  });
