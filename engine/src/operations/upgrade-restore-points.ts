import { mapFailures } from "@lando/sdk/command-result";
import { ServiceRestorePointError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type ServiceName,
  type SnapshotId,
  compareDataSeries,
  isIdleRunStatus,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { DataMover, EventService, RuntimeProvider } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { coordinatedServiceVolume } from "../lifecycle/volume-coordination.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import type { DataUpgrade } from "./data-version-admission.ts";
import { catalogMount } from "./database-convergence/target.ts";

const observeBounded = Effect.timeout("2 seconds");

const restoreCommand = (id: SnapshotId, service: ServiceName) =>
  `lando db:restore ${id} --service ${service}`;

const captureRestorePoint = Effect.fn("AppActivation.captureRestorePoint")(function* (input: {
  readonly app: string;
  readonly upgrade: DataUpgrade;
  readonly provider: PreparedRuntimeProvider;
  readonly mover: DataMover["Service"];
  readonly onSuspend: (resume: Effect.Effect<void, ServiceRestorePointError>) => void;
}) {
  const { app, upgrade, provider, mover, onSuspend } = input;
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
  if (runtime.status === "running") {
    const { suspend, resume } = provider;
    if (suspend === undefined || resume === undefined)
      return yield* error("the provider cannot safely stop and resume this exact container.");
    const resumeOriginal = Effect.gen(function* () {
      const current = yield* inspect;
      if (
        current.containerId === containerId &&
        current.imageIdentity === imageIdentity &&
        current.status === "exited"
      )
        yield* resume(target, identity).pipe(
          mapFailures(() => error("the original database could not resume.")),
        );
    });
    yield* Effect.gen(function* () {
      onSuspend(resumeOriginal);
      yield* suspend(target, identity).pipe(mapFailures(() => error("the database could not be stopped.")));
    }).pipe(Effect.uninterruptible);
    yield* proveVolume;
  }
  return yield* Effect.scoped(
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
});

export const withUpgradeRestorePoints =
  (input: {
    readonly app: string;
    readonly provider: PreparedRuntimeProvider;
    readonly upgrades: readonly DataUpgrade[];
    readonly noSnapshot: boolean | undefined;
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
      const suspended: Effect.Effect<void, ServiceRestorePointError>[] = [];
      return yield* Effect.gen(function* () {
        for (const upgrade of input.upgrades) {
          const { service, label, to } = upgrade;
          if (Option.isNone(mover)) {
            yield* notice(`No restore point was saved for ${service}: the data mover is unavailable.`);
            continue;
          }
          yield* notice(`Saving a restore point of ${service} before moving to ${label} ${to}…`);
          const handle = yield* captureRestorePoint({
            app: input.app,
            provider: input.provider,
            mover: mover.value,
            upgrade,
            onSuspend: (resume) => suspended.push(resume),
          });
          points.set(service, handle.id);
          yield* notice(`Saved restore point ${handle.id} for ${service}.`);
        }
        const result = yield* body(points);
        for (const [service, id] of points) {
          yield* notice(
            `Restore point ${id} is available for ${service}. To roll back, set the original database version, run \`${restoreCommand(id, service)}\`, then run \`lando start\`.`,
          );
        }
        return result;
      }).pipe(
        Effect.onError(() =>
          Effect.forEach(
            suspended.toReversed(),
            (resume) => resume.pipe(Effect.catch((failure) => Effect.logWarning(failure.message))),
            { discard: true },
          ),
        ),
      );
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
