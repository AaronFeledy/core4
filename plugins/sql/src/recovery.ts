import { Effect, Exit } from "effect";

import { SqlRecoveryOperationError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { SnapshotMetadata } from "@lando/sdk/schema";

import {
  type SqlPhysicalContextInput,
  type SqlRecoveryContext,
  resolvePhysicalContext,
  resolvePhysicalTarget,
} from "./recovery-target.ts";
import { sameRuntime } from "./runtime-observation.ts";

export type { SqlRecoveryContext, SqlRecoveryDeps } from "./recovery-target.ts";

type SqlPhysicalOperation<A, E> = SqlPhysicalContextInput & {
  readonly reason: Exclude<SnapshotMetadata["recoveryReason"], "seed">;
  readonly resumeAfterSnapshot: boolean;
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
        target.identity.coordinationKey,
        resolvePhysicalTarget(input).pipe(
          Effect.flatMap(
            (lockedTarget): Effect.Effect<A, E | SqlRecoveryUnavailableError | unknown> =>
              lockedTarget.identity.coordinationKey === target.identity.coordinationKey &&
              lockedTarget.identity.generation === target.identity.generation &&
              lockedTarget.identity.ownerRoot === target.identity.ownerRoot &&
              lockedTarget.volume.ref.store === target.volume.ref.store &&
              lockedTarget.identity.nativeName === target.identity.nativeName &&
              sameRuntime(target.runtime, lockedTarget.runtime)
                ? resolvePhysicalContext(input, lockedTarget).pipe(
                    Effect.flatMap((context) => Effect.suspend(() => input.body(context))),
                  )
                : Effect.fail(
                    new SqlRecoveryUnavailableError({
                      message: `The physical volume for ${input.serviceName} changed while acquiring its lock.`,
                      service: input.serviceName,
                      reason: "The acquired lock belongs to a different volume or runtime instance.",
                      remediation: "Retry after the concurrent lifecycle operation completes.",
                    }),
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
    body: (context) =>
      Effect.gen(function* () {
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
        return yield* input.body(context, recovery.id).pipe(
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
      }),
  });
