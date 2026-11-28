import { mapFailures } from "@lando/sdk/command-result";
import { ServiceRestorePointError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type SnapshotHandle,
  compareDataSeries,
  isIdleRunStatus,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { type DataMover, EventService, RuntimeProvider } from "@lando/sdk/services";
import { DateTime, Effect, Result } from "effect";
import { coordinatedServiceVolume } from "../lifecycle/volume-coordination.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import type { DataUpgrade } from "./data-version-admission.ts";
import { prepareSnapshotHelper, readOfflineVersion } from "./data-version-records.ts";
import { catalogMount } from "./database-convergence/target.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { refuseDataVersion } from "./upgrade-restore-remediation.ts";
import { UpgradeTeardown } from "./upgrade-teardown-boundary.ts";

const observeBounded = Effect.timeout("2 seconds");

export type UndoCapture = Effect.Effect<string | undefined, ServiceRestorePointError>;

export const captureRestorePoint = Effect.fn("AppActivation.captureRestorePoint")(function* (input: {
  readonly plan: AppPlan;
  readonly upgrade: DataUpgrade;
  readonly provider: PreparedRuntimeProvider;
  readonly publication?: {
    readonly mover: DataMover["Service"];
    readonly onPrepare: (undo: UndoCapture) => void;
    readonly onCommit: (handle: SnapshotHandle) => void;
    readonly onDiscard: (handle: SnapshotHandle) => void;
  };
}) {
  const { plan, upgrade, provider, publication } = input;
  const app = plan.name;
  const { appliedPlan, service, target: destination, store, label, from, to } = upgrade;
  const error = (reason: string, cause?: unknown) =>
    new ServiceRestorePointError({
      app,
      service,
      dataVersion: { label, from, to },
      message: `Could not save a restore point for ${service}: ${reason}`,
      ...(cause === undefined ? {} : { cause }),
      remediation:
        "Check free disk space and the database volume, then retry. Pass `--no-snapshot` only if you have a backup or accept upgrading without a restore point.",
    });
  const rollbackError = (message: string, remediation: string, cause: unknown) =>
    new ServiceRestorePointError({
      app,
      service,
      dataVersion: { label, from, to },
      message,
      remediation,
      cause,
    });
  const target = { app: appliedPlan.id, service, plan: appliedPlan };
  const applied = appliedPlan.services[service];
  const family = applied?.connection?.family;
  const privateMount = applied === undefined ? undefined : catalogMount(appliedPlan, applied);
  const observeVolume = provider.observeBoundVolume;
  const expected = yield* coordinatedServiceVolume(appliedPlan, store);
  if (
    family === undefined ||
    privateMount?.target !== destination ||
    privateMount.store !== store ||
    observeVolume === undefined ||
    expected?.identity === undefined
  )
    return yield* error("the provider could not prove the coordinated database storage.");
  const inspect = provider.inspect(target).pipe(
    observeBounded,
    mapFailures(() => error("the applied database container could not be observed.")),
  );
  const runtime = yield* inspect;
  const { containerId, imageIdentity } = runtime;
  const owner = planAppIdentity(appliedPlan);
  if (
    containerId === undefined ||
    imageIdentity === undefined ||
    runtime.app !== appliedPlan.id ||
    runtime.appRoot !== owner.appRoot ||
    runtime.service !== service ||
    runtime.providerId !== provider.id ||
    (runtime.status !== "running" && !isIdleRunStatus(runtime.status))
  )
    return yield* error("the applied database container, image, or run state could not be proven.");
  const identity = { containerId, imageIdentity };
  const proveVolume = observeVolume({ ...target, expectedContainerId: containerId }, destination).pipe(
    observeBounded,
    mapFailures(() => error("the bound database volume could not be inspected.")),
    Effect.flatMap((volume) => {
      const physical = volume.identity;
      return physical !== undefined &&
        volume.ref.app === planDataId(appliedPlan) &&
        volume.ref.store === physical.nativeName &&
        physical.ownerRoot === owner.appRoot &&
        physical.nativeName === expected.nativeName &&
        physical.coordinationKey === expected.coordinationKey &&
        physical.generation === expected.identity?.generation
        ? Effect.succeed({ ref: volume.ref, physical })
        : Effect.fail(error("the mounted database volume is not the locked physical volume."));
    }),
  );
  const volume = yield* proveVolume;
  const desired = plan.services[service];
  const contract = desired?.dataVersion;
  const depth = contract?.series?.depth;
  const warnUnverified = Effect.fnUntraced(function* (reason: string) {
    const events = yield* EventService;
    yield* events
      .publish(
        MessageWarnEvent.make({
          body: `The database version for ${service} could not be verified: ${reason}.`,
          timestamp: yield* DateTime.now,
        }),
      )
      .pipe(Effect.ignore);
  });
  const verify = Effect.gen(function* () {
    if (contract === undefined || depth === undefined || desired === undefined) return undefined;
    const read = yield* readOfflineVersion({ provider, appliedPlan, mount: privateMount, contract });
    if (read.kind === "unavailable") yield* warnUnverified(read.reason);
    if (read.kind !== "verified") return undefined;
    const observed = read.version;
    yield* proveVolume;
    const comparison = compareDataSeries(observed, to, depth);
    if (comparison === 1)
      return yield* refuseDataVersion({
        desired: plan,
        appliedPlan,
        service: desired,
        mount: privateMount,
        label,
        depth,
        providerId: provider.id,
        finding: { direction: "downgrade", evidence: "record", dataVersion: observed, imageVersion: to },
        generation: volume.physical.generation,
        stopped: true,
      });
    if (publication !== undefined && comparison === 0)
      return yield* new ServiceRestorePointError({
        app,
        service,
        dataVersion: { label, from: to, to },
        message: `${service} already contains ${label} ${to} data. No upgrade restore point was saved.`,
        remediation: "Run the command again with `--no-snapshot` to start on the series already on disk.",
      });
    return comparison === -1 ? observed : undefined;
  });
  if (publication === undefined) {
    if (isIdleRunStatus(runtime.status)) {
      const prepared = yield* Effect.result(prepareSnapshotHelper(provider));
      if (Result.isSuccess(prepared)) yield* verify;
      else yield* warnUnverified("the storage helper image could not be acquired");
    }
    return undefined;
  }
  yield* prepareSnapshotHelper(provider).pipe(
    mapFailures((cause) => error("the snapshot helper image could not be acquired.", cause)),
  );
  const { mover, onPrepare, onCommit, onDiscard } = publication;
  const { suspend, resume } = provider;
  const wasRunning = runtime.status === "running";
  let handle: SnapshotHandle | undefined;
  const undo = Effect.gen(function* () {
    const teardown = yield* UpgradeTeardown;
    if (teardown?.has(appliedPlan.id))
      return handle === undefined
        ? undefined
        : `Kept restore point ${handle.id} for ${service}: teardown of the original runtime has begun.`;
    const current = yield* inspect;
    if (
      current.containerId !== containerId ||
      current.imageIdentity !== imageIdentity ||
      current.appRoot !== owner.appRoot ||
      current.app !== appliedPlan.id ||
      current.service !== service ||
      current.providerId !== provider.id ||
      (current.status !== "running" && !isIdleRunStatus(current.status))
    )
      return handle === undefined
        ? undefined
        : `Kept restore point ${handle.id} for ${service}: the original database could not be confirmed unchanged.`;
    if (wasRunning && current.status !== "running" && resume !== undefined)
      yield* resume(target, identity).pipe(
        mapFailures((cause) =>
          rollbackError(
            `The original database ${service} could not resume${handle === undefined ? "" : `; kept restore point ${handle.id}`}.`,
            "Check the provider error and restore the previous database configuration before starting the original service.",
            cause,
          ),
        ),
      );
    if (handle === undefined) return;
    const id = handle.id;
    yield* mover.removeSnapshot(handle).pipe(
      Effect.provideService(RuntimeProvider, provider),
      mapFailures((cause) =>
        rollbackError(
          `Unused restore point ${id} for ${service} could not be removed.`,
          "Fix the reported snapshot removal error before pruning unused recovery points with `lando db:snapshots:prune --recovery`.",
          cause,
        ),
      ),
    );
    onDiscard(handle);
    return `Removed unused restore point ${id} for ${service}: the original database was not replaced.`;
  });
  if (wasRunning) {
    if (suspend === undefined || resume === undefined)
      return yield* error("the provider cannot safely stop and resume this exact container.");
    yield* Effect.gen(function* () {
      onPrepare(undo);
      yield* markStartMutation(plan);
      yield* suspend(target, identity).pipe(mapFailures(() => error("the database could not be stopped.")));
    }).pipe(Effect.uninterruptible);
    yield* proveVolume;
  } else {
    onPrepare(undo);
  }
  const verified = yield* verify;
  const saved = yield* Effect.scoped(
    mover.snapshot(
      volume.ref,
      {
        format: "tar.gz",
        ...(owner.repoGroupKey === undefined ? {} : { repoGroupKey: owner.repoGroupKey }),
        metadata: {
          service,
          volumeInstanceId: volume.physical.generation,
          family,
          imageIdentity,
          recoveryReason: "upgrade",
          dataVersion: {
            label,
            series: verified ?? from,
            source: verified === undefined ? "applied-plan" : "record",
          },
        },
      },
      (captured) => {
        handle = captured;
        onCommit(captured);
      },
    ),
  ).pipe(
    Effect.provideService(RuntimeProvider, provider),
    mapFailures((cause) => error("the snapshot could not be written.", cause)),
  );
  return { handle: saved, verified };
});
