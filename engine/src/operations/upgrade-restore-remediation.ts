import {
  type AppPlan,
  type ServiceName,
  type SnapshotId,
  compareDataSeries,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { DataMover } from "@lando/sdk/services";
import { Effect, Option } from "effect";

export const restoreCommand = (id: SnapshotId, service: ServiceName) =>
  `lando db:restore ${id} --service ${service}`;

export const upgradeRestoreRemediation = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly service: ServiceName;
  readonly store: string;
  readonly label: string;
  readonly depth: 1 | 2;
  readonly series: string;
  readonly family: string | undefined;
  readonly generation: string;
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
    ({ metadata, sourceVolumeGeneration }) =>
      metadata?.recoveryReason === "upgrade" &&
      metadata.family === input.family &&
      (sourceVolumeGeneration ?? metadata.volumeInstanceId) === input.generation &&
      metadata.dataVersion?.label === input.label &&
      metadata.dataVersion.source !== "applied-plan" &&
      compareDataSeries(metadata.dataVersion.series, input.series, input.depth) === 0,
  );
  return match === undefined
    ? undefined
    : `To roll back, run \`${restoreCommand(match.id, input.service)}\`, then \`lando start\`.`;
});
