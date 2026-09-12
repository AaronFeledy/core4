import { Effect } from "effect";

import { SqlRecoveryOperationError, SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName, type SnapshotMetadata, type VolumeInfo } from "@lando/sdk/schema";

import { type SqlMover, runSnapshot } from "./actions.ts";
import type { SqlFamily } from "./families.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";

export type SqlRecoveryDeps = SqlMover & {
  readonly start: (service: string) => Effect.Effect<void, unknown>;
  readonly stop: (service: string) => Effect.Effect<void, unknown>;
  readonly inspect: (
    service: string,
  ) => Effect.Effect<{ readonly running: boolean; readonly imageIdentity?: string }, unknown>;
  readonly inspectVolume: (service: string, store: string) => Effect.Effect<VolumeInfo | undefined, unknown>;
  readonly withVolumeLock: <A, E>(
    instanceId: string,
    body: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | unknown>;
  readonly getSeedStatus: (
    instanceId: string,
  ) => Effect.Effect<"fresh" | "in-progress" | "seeded" | "failed", unknown>;
  readonly setSeedStatus: (
    instanceId: string,
    status: "fresh" | "in-progress" | "seeded" | "failed",
  ) => Effect.Effect<void, unknown>;
};

export type SqlRecoveryContext = {
  readonly running: boolean;
  readonly metadata: SnapshotMetadata;
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
    const storeName = input.service.storage[0]?.store;
    const volume =
      storeName === undefined ? undefined : yield* input.deps.inspectVolume(input.serviceName, storeName);
    const runtime = yield* input.deps.inspect(input.serviceName);
    const separator = input.service.type.indexOf(":");
    const version = input.service.version ?? (separator < 0 ? "" : input.service.type.slice(separator + 1));
    if (
      volume?.provenance !== "known" ||
      volume.instanceId === undefined ||
      runtime.imageIdentity === undefined ||
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
    return {
      running: runtime.running,
      metadata: {
        sourceRoot: AbsolutePath.make(input.plan.root),
        ...(input.plan.identity?.ownerKey === undefined ? {} : { ownerKey: input.plan.identity.ownerKey }),
        ...(input.plan.identity?.repoGroupKey === undefined
          ? {}
          : { repoGroupKey: input.plan.identity.repoGroupKey }),
        service: ServiceName.make(input.serviceName),
        volumeInstanceId: volume.instanceId,
        family: input.family,
        version,
        imageIdentity: runtime.imageIdentity,
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
      input.deps.withVolumeLock(context.metadata.volumeInstanceId, input.body(context)),
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
        const recovery = yield* runSnapshot(
          input.deps,
          input.plan,
          input.service,
          input.serviceName,
          input.label,
          { ...context.metadata, recoveryReason: input.reason },
          input.format,
        );
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
