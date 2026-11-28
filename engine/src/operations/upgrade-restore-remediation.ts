import { dataVersionRemediation } from "@lando/container-runtime/data-version-diagnostic";
import { ServiceDataVersionError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ServiceDataVersionFinding,
  type ServiceName,
  type ServicePlan,
  type SnapshotId,
  type VolumeMountPlan,
  compareDataSeries,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { DataMover } from "@lando/sdk/services";
import { Effect, Option } from "effect";

export const restoreCommand = (id: SnapshotId, service: ServiceName) =>
  `lando db:restore ${id} --service ${service}`;

const upgradeRestoreRemediation = Effect.fnUntraced(function* (input: {
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

export const refuseDataVersion = Effect.fnUntraced(function* (input: {
  readonly desired: AppPlan;
  readonly appliedPlan: AppPlan;
  readonly service: ServicePlan;
  readonly mount: VolumeMountPlan;
  readonly label: string;
  readonly depth: 1 | 2;
  readonly providerId: string;
  readonly finding: ServiceDataVersionFinding & { readonly imageVersion: string };
  readonly generation: string;
  readonly stopped?: boolean;
}) {
  const { desired, appliedPlan, service, mount, label, depth, providerId, finding, generation } = input;
  const { dataVersion: from, imageVersion: to } = finding;
  const applied = appliedPlan.services[service.name];
  const data =
    finding.evidence === "running-image"
      ? `data last opened by ${label} ${from}`
      : `data with recorded ${label} version ${from}`;
  const restore =
    finding.direction === "downgrade"
      ? yield* upgradeRestoreRemediation({
          plan: appliedPlan,
          service: service.name,
          store: mount.store,
          label,
          depth,
          series: to,
          family: service.connection?.family,
          generation,
        })
      : undefined;
  const unchanged =
    input.stopped === true
      ? "the previous container was not replaced"
      : "the previous container is still running unchanged";
  return yield* new ServiceDataVersionError({
    app: desired.name,
    service: service.name,
    providerId,
    image: service.artifact?.kind === "ref" ? service.artifact.ref : to,
    ...(applied?.artifact?.kind === "ref" ? { appliedImage: applied.artifact.ref } : {}),
    dataVersion: finding,
    message: `Service ${service.name}: ${unchanged}. ${label} ${to} cannot open ${data}.`,
    remediation: [restore, dataVersionRemediation(desired, service, { finding })].filter(Boolean).join(" "),
  });
});
