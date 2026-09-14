import { Effect } from "effect";

import { SqlRecoveryOperationError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  ServiceName,
  type SnapshotMetadata,
  type VolumeInfo,
  type VolumeRef,
} from "@lando/sdk/schema";
import type { VolumeIdentity } from "@lando/sdk/schema";
import type { VolumeInitialization } from "@lando/sdk/services";

import type { SqlMover } from "./actions.ts";
import type { SqlFamily } from "./families.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";
import { requireDatabaseMount } from "./volume-target.ts";

export type SqlRecoveryDeps = SqlMover & {
  readonly start: (service: string) => Effect.Effect<void, unknown>;
  readonly stop: (service: string) => Effect.Effect<void, unknown>;
  readonly inspect: (
    service: string,
  ) => Effect.Effect<{ readonly running: boolean; readonly imageIdentity?: string }, unknown>;
  readonly inspectVolume: (
    service: string,
    store: string,
    destination?: string,
  ) => Effect.Effect<VolumeInfo | undefined, unknown>;
  readonly withVolumeLock: <A, E>(
    instanceId: string,
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | unknown>;
  readonly initialization: (identity: VolumeIdentity) => Effect.Effect<VolumeInitialization, unknown>;
};

export type SqlRecoveryContext = {
  readonly running: boolean;
  readonly metadata: SnapshotMetadata;
  readonly volumeIdentity: VolumeIdentity;
  readonly volume: VolumeRef;
  readonly verifyVolume: Effect.Effect<void, unknown>;
};

type SqlPhysicalContextInput = Omit<
  SqlPhysicalOperation<never, never>,
  "reason" | "resumeAfterSnapshot" | "body"
>;

type SqlPhysicalOperation<A, E> = {
  readonly deps: SqlRecoveryDeps;
  readonly plan: SqlPlan;
  readonly service: SqlPlanService;
  readonly serviceName: string;
  readonly family: SqlFamily;
  readonly label?: string;
  readonly format?: "tar" | "tar.gz" | "tar.zst";
  readonly reason: Exclude<SnapshotMetadata["recoveryReason"], "seed">;
  readonly resumeAfterSnapshot: boolean;
  readonly preflight?: (context: SqlRecoveryContext) => Effect.Effect<void, unknown>;
  readonly body: (context: SqlRecoveryContext, recoveryId: string) => Effect.Effect<A, E>;
};

const resolvePhysicalContext = (input: SqlPhysicalContextInput) =>
  Effect.gen(function* () {
    const mount = yield* requireDatabaseMount(input.service, input.plan.id);
    const volume = yield* input.deps.inspectVolume(input.serviceName, mount.store, mount.target);
    const runtime = yield* input.deps.inspect(input.serviceName);
    const imageIdentity = runtime.imageIdentity;
    const separator = input.service.type.indexOf(":");
    const version = input.service.version ?? (separator < 0 ? "" : input.service.type.slice(separator + 1));
    if (
      volume?.identity === undefined ||
      volume.identity.ownerRoot !== input.plan.root ||
      volume.identity.nativeName !== volume.ref.store ||
      imageIdentity === undefined ||
      version.length === 0
    ) {
      return yield* Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `Cannot prove recovery compatibility for ${input.serviceName}.`,
          service: input.serviceName,
          reason: "Physical volume, image, or database-version provenance is unknown.",
          remediation: "Create a logical export before mutating this database.",
        }),
      );
    }
    const identity = volume.identity;
    const verifyVolume = Effect.suspend(() =>
      input.deps.inspectVolume(input.serviceName, mount.store, mount.target),
    ).pipe(
      Effect.flatMap((current) =>
        current?.identity?.coordinationKey === identity.coordinationKey &&
        current.identity.generation === identity.generation &&
        current.identity.ownerRoot === identity.ownerRoot &&
        current.identity.nativeName === identity.nativeName &&
        current.ref.store === volume.ref.store
          ? Effect.void
          : Effect.fail(
              new SqlRecoveryUnavailableError({
                message: `The mounted database volume for ${input.serviceName} changed.`,
                service: input.serviceName,
                reason: "The current mount does not match the locked physical target.",
                remediation: "Leave the database stopped and inspect its mounts before retrying recovery.",
              }),
            ),
      ),
    );
    return {
      running: runtime.running,
      volume: volume.ref,
      verifyVolume,
      volumeIdentity: identity,
      metadata: {
        sourceRoot: AbsolutePath.make(input.plan.root),
        ...(input.plan.identity?.ownerKey === undefined ? {} : { ownerKey: input.plan.identity.ownerKey }),
        ...(input.plan.identity?.repoGroupKey === undefined
          ? {}
          : { repoGroupKey: input.plan.identity.repoGroupKey }),
        service: ServiceName.make(input.serviceName),
        volumeInstanceId: identity.generation,
        family: input.family,
        version,
        imageIdentity,
        recoveryReason: "manual",
      } satisfies SnapshotMetadata,
    };
  });

export const withPhysicalVolumeLock = <A, E>(
  input: SqlPhysicalContextInput & {
    readonly body: (context: SqlRecoveryContext) => Effect.Effect<A, E>;
  },
) =>
  resolvePhysicalContext(input).pipe(
    Effect.flatMap((context) =>
      input.deps.withVolumeLock(
        context.volumeIdentity.coordinationKey,
        resolvePhysicalContext(input).pipe(
          Effect.flatMap(
            (lockedContext): Effect.Effect<A, E | SqlRecoveryUnavailableError> =>
              lockedContext.metadata.volumeInstanceId === context.metadata.volumeInstanceId &&
              lockedContext.volumeIdentity.coordinationKey === context.volumeIdentity.coordinationKey &&
              lockedContext.volumeIdentity.generation === context.volumeIdentity.generation &&
              lockedContext.volumeIdentity.ownerRoot === context.volumeIdentity.ownerRoot &&
              lockedContext.volume.store === context.volume.store &&
              lockedContext.volumeIdentity.nativeName === context.volumeIdentity.nativeName
                ? Effect.suspend(() => input.body(lockedContext))
                : Effect.fail(
                    new SqlRecoveryUnavailableError({
                      message: `The physical volume for ${input.serviceName} changed while acquiring its lock.`,
                      service: input.serviceName,
                      reason: "The acquired lock belongs to a different volume instance.",
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
    ...(input.label === undefined ? {} : { label: input.label }),
    body: (context) =>
      Effect.gen(function* () {
        if (input.preflight !== undefined) yield* input.preflight(context);
        if (context.running) yield* input.deps.stop(input.serviceName);
        yield* context.verifyVolume;
        const recovery = yield* input.deps.snapshot(context.volume, {
          format: input.format ?? "tar.gz",
          ...(input.label === undefined ? {} : { label: input.label }),
          metadata: { ...context.metadata, recoveryReason: input.reason },
        });
        if (input.resumeAfterSnapshot && context.running) yield* input.deps.start(input.serviceName);
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
