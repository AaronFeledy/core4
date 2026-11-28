import { annotateFailureContext, mapFailures } from "@lando/sdk/command-result";
import { type EventError, type ServiceDataVersionError, ServiceRestorePointError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type ServiceName,
  type SnapshotHandle,
  type SnapshotId,
  compareDataSeries,
  isIdleRunStatus,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { DataMover, EventService, RuntimeProvider, StateStore } from "@lando/sdk/services";
import { makeTaskTree, runWithTaskTree } from "@lando/sdk/task-progress";
import { DateTime, Effect, Exit, Option } from "effect";
import { mergeFailure, runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import { coordinatedServiceVolume } from "../lifecycle/volume-coordination.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { registerBuildRedaction } from "../services/build-redaction.ts";
import { withPrefetchedSourceArtifacts } from "../services/source-artifact.ts";
import { type DataUpgrade, refuseDataVersion } from "./data-version-admission.ts";
import { readOfflineVersion } from "./data-version-records.ts";
import { catalogMount } from "./database-convergence/target.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";
import { restoreCommand } from "./upgrade-restore-remediation.ts";

const observeBounded = Effect.timeout("2 seconds");

type UndoCapture = Effect.Effect<string | undefined, ServiceRestorePointError>;
export type PrepareUpgrade = Effect.Effect<
  void,
  EventError | ServiceDataVersionError | ServiceRestorePointError,
  EventService
>;

const captureRestorePoint = Effect.fn("AppActivation.captureRestorePoint")(function* (input: {
  readonly app: string;
  readonly plan: AppPlan;
  readonly upgrade: DataUpgrade;
  readonly provider: PreparedRuntimeProvider;
  readonly publication?: {
    readonly mover: DataMover["Service"];
    readonly onPrepare: (undo: UndoCapture) => void;
    readonly onCommit: (handle: SnapshotHandle) => void;
  };
}) {
  const { app, plan, upgrade, provider, publication } = input;
  const { appliedPlan, service, target: destination, store, label, from, to, source } = upgrade;
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
  const verify = Effect.gen(function* () {
    if (source !== "applied-plan" || contract === undefined || depth === undefined || desired === undefined)
      return undefined;
    const observed = yield* readOfflineVersion({ provider, appliedPlan, mount: privateMount, contract });
    const comparison = observed === undefined ? undefined : compareDataSeries(observed, to, depth);
    if (observed !== undefined && comparison === 1)
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
    if (isIdleRunStatus(runtime.status)) yield* verify;
    return undefined;
  }
  const { mover, onPrepare, onCommit } = publication;
  const { suspend, resume } = provider;
  const wasRunning = runtime.status === "running";
  let handle: SnapshotHandle | undefined;
  const undo = Effect.gen(function* () {
    const current = yield* inspect;
    if (
      current.containerId !== containerId ||
      current.imageIdentity !== imageIdentity ||
      (current.status !== "running" && !isIdleRunStatus(current.status))
    )
      return handle === undefined
        ? undefined
        : `Kept restore point ${handle.id} for ${service}: the original database could not be confirmed unchanged.`;
    if (wasRunning && current.status !== "running" && resume !== undefined)
      yield* resume(target, identity).pipe(
        mapFailures((cause) =>
          error(
            `the original database could not resume${handle === undefined ? "" : `; kept restore point ${handle.id}`}.`,
            cause,
          ),
        ),
      );
    if (handle === undefined) return;
    const id = handle.id;
    yield* mover.removeSnapshot(handle).pipe(
      Effect.provideService(RuntimeProvider, provider),
      mapFailures((cause) => error(`unused restore point ${id} could not be removed.`, cause)),
    );
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
            source: verified === undefined ? source : "record",
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

export const withUpgradeRestorePoints =
  (input: {
    readonly plan: AppPlan;
    readonly provider: PreparedRuntimeProvider;
    readonly upgrades: readonly DataUpgrade[];
    readonly stoppedChecks: readonly DataUpgrade[];
    readonly noSnapshot: boolean | undefined;
    readonly refresh: boolean;
  }) =>
  <A, E, R>(
    body: (preparation: {
      readonly prepareUpgrade: PrepareUpgrade;
      readonly points: ReadonlyMap<ServiceName, SnapshotId>;
      readonly verifiedFrom: ReadonlyMap<ServiceName, string>;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.fn("AppActivation.withUpgradeRestorePoints")(function* () {
      const points = new Map<ServiceName, SnapshotId>();
      const verifiedFrom = new Map<ServiceName, string>();
      const unverified = new Set<ServiceName>();
      for (const upgrade of input.stoppedChecks) {
        yield* captureRestorePoint({
          app: input.plan.name,
          plan: input.plan,
          provider: input.provider,
          upgrade,
        }).pipe(Effect.catchTag("ServiceRestorePointError", () => Effect.void));
      }
      if (input.noSnapshot === true || input.upgrades.length === 0)
        return yield* body({ prepareUpgrade: Effect.void, points, verifiedFrom });
      const mover = yield* Effect.serviceOption(DataMover);
      const events = yield* EventService;
      const notice = (body: string) =>
        DateTime.now.pipe(
          Effect.flatMap((timestamp) => events.publish(MessageInfoEvent.make({ body, timestamp }))),
        );
      const prepared: UndoCapture[] = [];
      const capture = Effect.gen(function* () {
        if (Option.isNone(mover)) {
          for (const { service } of input.upgrades)
            yield* notice(`No restore point was saved for ${service}: the data mover is unavailable.`);
          return;
        }
        yield* notice(
          "The database stays offline while Lando copies its data. Allow free disk space about the size of its volume.",
        );
        const tree = makeTaskTree(events, {
          parentId: `upgrade-restore-point:${input.plan.id}`,
          label: `Save database upgrade restore points for ${input.plan.name}`,
          children: input.upgrades.map(({ service }) => ({ id: service, label: `Save ${service}` })),
          prefixChildIds: true,
        });
        yield* runWithTaskTree(
          tree,
          (active) =>
            Effect.gen(function* () {
              for (const upgrade of input.upgrades) {
                const { service, label, to } = upgrade;
                yield* notice(`Saving a restore point of ${service} before moving to ${label} ${to}…`);
                yield* active.startTask(service);
                const captured = yield* captureRestorePoint({
                  app: input.plan.name,
                  plan: input.plan,
                  provider: input.provider,
                  upgrade,
                  publication: {
                    mover: mover.value,
                    onPrepare: (undo) => prepared.push(undo),
                    onCommit: (snapshot) => points.set(service, snapshot.id),
                  },
                });
                if (captured === undefined) continue;
                const { handle, verified } = captured;
                if (verified !== undefined) verifiedFrom.set(service, verified);
                if (verified === undefined && upgrade.source === "applied-plan") unverified.add(service);
                yield* notice(`Saved restore point ${handle.id} for ${service}.`);
                yield* active.completeTask(service);
              }
            }),
          {
            success: "Database restore points saved",
            failure: "Database restore point capture failed",
            interrupt: "Database restore point capture interrupted",
          },
        );
      });
      const prepareUpgrade = yield* Effect.cached(capture);
      const activation = Effect.suspend(() => body({ prepareUpgrade, points, verifiedFrom }));
      const settle = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(activation));
          if (Exit.isSuccess(exit)) return exit.value;
          const cleanup = yield* Effect.exit(
            runAllAndMergeFailures(
              prepared.toReversed().map((undo) =>
                Effect.gen(function* () {
                  const message = yield* undo;
                  if (message !== undefined) yield* notice(message).pipe(Effect.ignoreCause);
                }),
              ),
            ),
          );
          const cause = Exit.isFailure(cleanup)
            ? mergeFailure(exit.cause, cleanup.cause, "rollback")
            : exit.cause;
          return yield* Effect.failCause(
            points.size === 0
              ? cause
              : annotateFailureContext(cause, { restorePointIds: [...points.values()] }),
          );
        }),
      );
      const result =
        Option.isSome(mover) && input.provider.capabilities.artifactPull
          ? yield* withPrefetchedSourceArtifacts(
              {
                provider: input.provider,
                services: Object.values(input.plan.services).filter(({ name }) =>
                  input.upgrades.some(({ service }) => service === name),
                ),
                options: {
                  refresh: input.refresh,
                  events,
                  stateStore: yield* StateStore,
                  redactor: (yield* registerBuildRedaction(input.plan)).redactor,
                },
              },
              settle,
            )
          : yield* settle;
      for (const [service, id] of points) {
        yield* notice(
          unverified.has(service)
            ? `Restore point ${id} is available for ${service}, but its data series could not be verified. Check the series independently before using \`${restoreCommand(id, service)} --any-series\`.`
            : `Restore point ${id} is available for ${service}. To roll back, set the original database version, run \`${restoreCommand(id, service)}\`, then run \`lando start\`.`,
        );
      }
      return result;
    });
