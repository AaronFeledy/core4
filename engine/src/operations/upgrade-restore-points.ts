import { mapFailures } from "@lando/sdk/command-result";
import { ServiceRestorePointError } from "@lando/sdk/errors";
import { MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
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
import { DateTime, Effect, Option } from "effect";
import { coordinatedServiceVolume } from "../lifecycle/volume-coordination.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { registerBuildRedaction } from "../services/build-redaction.ts";
import { withPrefetchedSourceArtifacts } from "../services/source-artifact.ts";
import type { DataUpgrade } from "./data-version-admission.ts";
import { catalogMount } from "./database-convergence/target.ts";

const observeBounded = Effect.timeout("2 seconds");

const restoreCommand = (id: SnapshotId, service: ServiceName) =>
  `lando db:restore ${id} --service ${service}`;

type UndoCapture = Effect.Effect<string | undefined, ServiceRestorePointError>;

const captureRestorePoint = Effect.fn("AppActivation.captureRestorePoint")(function* (input: {
  readonly app: string;
  readonly upgrade: DataUpgrade;
  readonly provider: PreparedRuntimeProvider;
  readonly mover: DataMover["Service"];
  readonly onPrepare: (undo: UndoCapture) => void;
}) {
  const { app, upgrade, provider, mover, onPrepare } = input;
  const { appliedPlan, service, target: destination, store, label, from, to, source } = upgrade;
  const error = (reason: string) =>
    new ServiceRestorePointError({
      app,
      service,
      dataVersion: { label, from, to },
      message: `Could not save a restore point for ${service}: ${reason}`,
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
    expected === undefined
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
        mapFailures(() => error("the original database could not resume.")),
      );
    if (handle === undefined) return;
    const id = handle.id;
    yield* mover.removeSnapshot(handle).pipe(
      Effect.provideService(RuntimeProvider, provider),
      mapFailures(() => error(`unused restore point ${id} could not be removed.`)),
    );
    return `Removed unused restore point ${id} for ${service}: the original database was not replaced.`;
  });
  if (wasRunning) {
    if (suspend === undefined || resume === undefined)
      return yield* error("the provider cannot safely stop and resume this exact container.");
    yield* Effect.gen(function* () {
      onPrepare(undo);
      yield* suspend(target, identity).pipe(mapFailures(() => error("the database could not be stopped.")));
    }).pipe(Effect.uninterruptible);
    yield* proveVolume;
  } else {
    onPrepare(undo);
  }
  const snapshot = Effect.scoped(
    mover.snapshot(volume.ref, {
      format: "tar.gz",
      ...(owner.repoGroupKey === undefined ? {} : { repoGroupKey: owner.repoGroupKey }),
      metadata: {
        service,
        volumeInstanceId: volume.physical.generation,
        family,
        imageIdentity,
        recoveryReason: "upgrade",
        dataVersion: { label, series: from, source },
      },
    }),
  ).pipe(
    Effect.provideService(RuntimeProvider, provider),
    mapFailures(() => error("the snapshot could not be written.")),
  );
  return yield* Effect.uninterruptibleMask((restore) =>
    restore(snapshot).pipe(
      Effect.tap((captured) =>
        Effect.sync(() => {
          handle = captured;
        }),
      ),
    ),
  );
});

export const withUpgradeRestorePoints =
  (input: {
    readonly plan: AppPlan;
    readonly provider: PreparedRuntimeProvider;
    readonly upgrades: readonly DataUpgrade[];
    readonly noSnapshot: boolean | undefined;
    readonly refresh: boolean;
  }) =>
  <A, E, R>(body: (points: ReadonlyMap<ServiceName, SnapshotId>) => Effect.Effect<A, E, R>) =>
    Effect.fn("AppActivation.withUpgradeRestorePoints")(function* () {
      const points = new Map<ServiceName, SnapshotId>();
      if (input.noSnapshot === true || input.upgrades.length === 0) return yield* body(points);
      const mover = yield* Effect.serviceOption(DataMover);
      const events = yield* EventService;
      const notice = (body: string) =>
        DateTime.now.pipe(
          Effect.flatMap((timestamp) => events.publish(MessageInfoEvent.make({ body, timestamp }))),
        );
      const prepared: UndoCapture[] = [];
      const activation = Effect.gen(function* () {
        for (const upgrade of input.upgrades) {
          const { service, label, to } = upgrade;
          if (Option.isNone(mover)) {
            yield* notice(`No restore point was saved for ${service}: the data mover is unavailable.`);
            continue;
          }
          yield* notice(`Saving a restore point of ${service} before moving to ${label} ${to}…`);
          const handle = yield* captureRestorePoint({
            app: input.plan.name,
            provider: input.provider,
            mover: mover.value,
            upgrade,
            onPrepare: (undo) => prepared.push(undo),
          });
          points.set(service, handle.id);
          yield* notice(`Saved restore point ${handle.id} for ${service}.`);
        }
        return yield* body(points);
      }).pipe(
        Effect.onError(() =>
          Effect.forEach(
            prepared.toReversed(),
            (undo) =>
              Effect.gen(function* () {
                const message = yield* undo;
                if (message !== undefined) yield* notice(message);
              }).pipe(
                Effect.catch((failure) =>
                  DateTime.now.pipe(
                    Effect.flatMap((timestamp) =>
                      events.publish(MessageWarnEvent.make({ body: failure.message, timestamp })),
                    ),
                    Effect.catch((failure) => Effect.logWarning(failure.message)),
                  ),
                ),
              ),
            { discard: true },
          ),
        ),
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
              activation,
            )
          : yield* activation;
      for (const [service, id] of points) {
        yield* notice(
          `Restore point ${id} is available for ${service}. To roll back, set the original database version, run \`${restoreCommand(id, service)}\`, then run \`lando start\`.`,
        );
      }
      return result;
    });

export const upgradeRestoreRemediation = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly service: ServiceName;
  readonly store: string;
  readonly label: string;
  readonly depth: 1 | 2;
  readonly series: string;
  readonly family: string | undefined;
}) {
  const mover = yield* Effect.serviceOption(DataMover);
  if (Option.isNone(mover) || input.family === undefined) return undefined;
  const owner = planAppIdentity(input.plan);
  const snapshots = yield* mover.value
    .listSnapshots({
      app: planDataId(input.plan),
      ownerKey: owner.ownerKey,
      store: input.store,
      service: input.service,
    })
    .pipe(Effect.catch(() => Effect.succeed([])));
  const match = snapshots.findLast(
    ({ metadata }) =>
      metadata?.recoveryReason === "upgrade" &&
      metadata.family === input.family &&
      metadata.dataVersion?.label === input.label &&
      compareDataSeries(metadata.dataVersion.series, input.series, input.depth) === 0,
  );
  return match === undefined
    ? undefined
    : `To roll back, run \`${restoreCommand(match.id, input.service)}\`, then \`lando start\`.`;
});
