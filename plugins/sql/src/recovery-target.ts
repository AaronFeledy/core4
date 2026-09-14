import { Effect } from "effect";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import type { SnapshotMetadata, VolumeIdentity, VolumeInfo, VolumeRef } from "@lando/sdk/schema";
import type { VolumeInitialization } from "@lando/sdk/services";

import type { SqlMover } from "./actions.ts";
import type { SqlCreds } from "./creds.ts";
import type { SqlFamily } from "./families.ts";
import {
  type ObservedSqlRuntime,
  type SqlRuntimeObservationDeps,
  observeDatabaseVersion,
  recoveryUnavailable,
  requireRuntimeIdentity,
  verifyRuntimeState,
} from "./runtime-observation.ts";
import type { SqlPlan, SqlPlanService } from "./views.ts";
import { requireDatabaseMount } from "./volume-target.ts";

export type SqlRecoveryDeps = SqlMover &
  SqlRuntimeObservationDeps & {
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
  readonly resume: Effect.Effect<void, unknown>;
  readonly suspend: Effect.Effect<void, unknown>;
  readonly verifyVolume: Effect.Effect<void, unknown>;
};

export type SqlPhysicalContextInput = {
  readonly deps: SqlRecoveryDeps;
  readonly plan: SqlPlan;
  readonly service: SqlPlanService;
  readonly serviceName: string;
  readonly family: SqlFamily;
  readonly creds: SqlCreds;
  readonly env: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly format?: "tar" | "tar.gz" | "tar.zst";
  readonly preflight?: (context: SqlRecoveryContext) => Effect.Effect<void, unknown>;
};

export type SqlPhysicalTarget = {
  readonly identity: VolumeIdentity;
  readonly mountStore: string;
  readonly mountTarget?: string;
  readonly runtime: ObservedSqlRuntime;
  readonly volume: VolumeInfo & { readonly identity: VolumeIdentity };
};

const canonicalAppRoot = (plan: SqlPhysicalContextInput["plan"]): string =>
  plan.identity?.appRoot ?? plan.root;

export const resolvePhysicalTarget = (input: SqlPhysicalContextInput) =>
  Effect.gen(function* () {
    const mount = yield* requireDatabaseMount(input.service, input.plan.id);
    const volume = yield* input.deps.inspectVolume(input.serviceName, mount.store, mount.target);
    if (
      volume?.identity === undefined ||
      volume.identity.ownerRoot !== canonicalAppRoot(input.plan) ||
      volume.identity.nativeName !== volume.ref.store
    ) {
      return yield* Effect.fail(
        recoveryUnavailable(
          input.serviceName,
          "Physical volume provenance is unknown.",
          "Create a logical export before mutating this database.",
        ),
      );
    }
    const runtime = yield* requireRuntimeIdentity(
      input.serviceName,
      yield* input.deps.inspect(input.serviceName),
    );
    return {
      identity: volume.identity,
      mountStore: mount.store,
      ...(mount.target === undefined ? {} : { mountTarget: mount.target }),
      runtime,
      volume: { ...volume, identity: volume.identity },
    } satisfies SqlPhysicalTarget;
  });

export const resolvePhysicalContext = (input: SqlPhysicalContextInput, target: SqlPhysicalTarget) =>
  Effect.gen(function* () {
    const version = yield* observeDatabaseVersion({
      deps: input.deps,
      service: input.serviceName,
      family: input.family,
      creds: input.creds,
      env: input.env,
      runtime: target.runtime,
    });
    const identity = target.identity;
    const verifyVolume = Effect.suspend(() =>
      input.deps.inspectVolume(input.serviceName, target.mountStore, target.mountTarget),
    ).pipe(
      Effect.flatMap((current) =>
        current?.identity?.coordinationKey === identity.coordinationKey &&
        current.identity.generation === identity.generation &&
        current.identity.ownerRoot === identity.ownerRoot &&
        current.identity.nativeName === identity.nativeName &&
        current.ref.store === target.volume.ref.store
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
    const exactTransition = (running: boolean, transition: Effect.Effect<void, unknown>) =>
      transition.pipe(
        Effect.mapError(() =>
          recoveryUnavailable(
            input.serviceName,
            running
              ? "The inspected database runtime could not be resumed after recovery."
              : "The inspected database runtime could not be stopped before recovery.",
            running
              ? "Leave the database stopped and restore the reported recovery snapshot before retrying."
              : "Leave the database stopped, inspect the service container, and retry recovery.",
          ),
        ),
        Effect.zipRight(verifyRuntimeState(input.deps, input.serviceName, target.runtime, running)),
      );
    return {
      running: target.runtime.running,
      volume: target.volume.ref,
      resume: exactTransition(true, input.deps.resume(input.serviceName, target.runtime)),
      suspend: exactTransition(false, input.deps.suspend(input.serviceName, target.runtime)),
      verifyVolume,
      volumeIdentity: identity,
      metadata: {
        sourceRoot: AbsolutePath.make(canonicalAppRoot(input.plan)),
        ...(input.plan.identity?.ownerKey === undefined ? {} : { ownerKey: input.plan.identity.ownerKey }),
        ...(input.plan.identity?.repoGroupKey === undefined
          ? {}
          : { repoGroupKey: input.plan.identity.repoGroupKey }),
        service: ServiceName.make(input.serviceName),
        volumeInstanceId: identity.generation,
        family: input.family,
        version,
        imageIdentity: target.runtime.imageIdentity,
        recoveryReason: "manual",
      } satisfies SnapshotMetadata,
    };
  });
