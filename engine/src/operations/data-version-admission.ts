import { ownsServiceContainer } from "@lando/container-runtime/native-ownership";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type PortablePath,
  type ServiceDataVersion,
  type ServiceName,
  type ServicePlan,
  type VolumeMountPlan,
  compareDataSeries,
  isIdleRunStatus,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import { EventService, type ProviderError } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { decodeVersionRecords, versionRecordCommand } from "./data-version-records.ts";
import { refuseDataVersion } from "./upgrade-restore-remediation.ts";

export interface DataUpgrade {
  readonly service: ServiceName;
  readonly target: PortablePath;
  readonly store: string;
  readonly appliedPlan: AppPlan;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly source: Evidence["source"] | "applied-plan";
}

type Evidence = {
  readonly version: string;
  readonly source: "record" | "running-image";
  readonly generation: string;
};
type Series = NonNullable<ServiceDataVersion["series"]>;

const dataMount = (service: ServicePlan, target: PortablePath) =>
  service.mounts.find((mount) => mount.type === "volume" && mount.target === target);

const immutableImageId = (value: string | undefined) =>
  /^(?:sha256:)?([a-f0-9]{64})$/u.exec(value ?? "")?.[1];

const versionEvidence = Effect.fnUntraced(
  function* (input: {
    readonly provider: PreparedRuntimeProvider;
    readonly appliedPlan: AppPlan;
    readonly service: ServicePlan;
    readonly mount: VolumeMountPlan;
    readonly contract: ServiceDataVersion;
    readonly series: Series;
    readonly appliedSeries: string | undefined;
  }) {
    const { provider, appliedPlan, service, mount, contract, series, appliedSeries } = input;
    const target = { app: appliedPlan.id, service: service.name, plan: appliedPlan };
    const runtime = yield* provider.inspect(target);
    const root = planAppIdentity(appliedPlan).appRoot;
    if (
      runtime.app !== target.app ||
      runtime.appRoot !== root ||
      runtime.providerId !== appliedPlan.provider ||
      runtime.service !== service.name
    )
      return undefined;
    if (isIdleRunStatus(runtime.status)) return "stopped" as const;
    if (
      runtime.status !== "running" ||
      !runtime.containerId ||
      (runtime.labels !== undefined && !ownsServiceContainer(appliedPlan, runtime)) ||
      mount.subpath !== undefined ||
      !provider.capabilities.serviceExec ||
      provider.observeBoundVolume === undefined
    )
      return undefined;
    const paths = series.records.map(({ path }) => path);
    const shadows = (target: string, path: string) =>
      target.startsWith(`${mount.target}/`) && (target === path || path.startsWith(`${target}/`));
    if (
      paths.length === 0 ||
      paths.some(
        (path) =>
          !path.startsWith(`${mount.target}/`) ||
          service.mounts.some(({ target }) => shadows(target, path)) ||
          (runtime.mounts?.status === "present" &&
            runtime.mounts.mounts.some(({ target }) => shadows(target, path))),
      )
    )
      return undefined;
    const bound = { ...target, expectedContainerId: runtime.containerId };
    const volume = yield* provider.observeBoundVolume(bound, mount.target);
    if (
      volume.ref.app !== planDataId(appliedPlan) ||
      volume.ref.store !== mount.store ||
      volume.identity?.nativeName !== mount.store ||
      volume.identity.ownerRoot !== root
    )
      return undefined;

    // Read each file at most up to 4 KiB (+1 to recognize truncation), with one pinned exec.
    const read = yield* provider.exec(bound, { command: versionRecordCommand(paths), raw: true });
    const records = decodeVersionRecords(read, paths, contract);
    if (records === undefined) return undefined;
    const { version, missing } = records;
    const artifact = service.artifact;
    const expectedImage =
      artifact?.kind === "ref"
        ? immutableImageId(artifact.digest ?? artifact.ref.split("@").at(-1))
        : undefined;
    if (
      runtime.health === "healthy" &&
      appliedSeries !== undefined &&
      expectedImage !== undefined &&
      expectedImage === immutableImageId(runtime.imageIdentity) &&
      (version === undefined ? missing : compareDataSeries(appliedSeries, version, series.depth) === 1)
    )
      return {
        version: appliedSeries,
        source: "running-image",
        generation: volume.identity.generation,
      } satisfies Evidence;
    if (version !== undefined)
      return { version, source: "record", generation: volume.identity.generation } satisfies Evidence;
    return missing ? ("no-record" as const) : undefined;
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
);

export const assessDataVersions = Effect.fn("AppActivation.assessDataVersions")(function* (
  desired: AppPlan,
  appliedPlans: readonly AppPlan[],
  provider: Effect.Effect<PreparedRuntimeProvider, ProviderError>,
) {
  const dataUpgrades: DataUpgrade[] = [];
  const stoppedChecks: DataUpgrade[] = [];
  for (const service of Object.values(desired.services)) {
    const contract = service.dataVersion;
    const series = contract?.series;
    if (contract === undefined || series === undefined || series.image === undefined) continue;
    const mount = dataMount(service, contract.target);
    if (
      mount === undefined ||
      mount.type !== "volume" ||
      !desired.stores.some(({ name, kind }) => name === mount.store && kind === "data")
    )
      continue;
    let upgrade: DataUpgrade | undefined;
    for (const appliedPlan of appliedPlans) {
      const applied = appliedPlan.services[service.name];
      if (applied === undefined) continue;
      const previousMount = dataMount(applied, contract.target);
      if (
        previousMount?.type !== "volume" ||
        previousMount.store !== mount.store ||
        previousMount.subpath !== mount.subpath
      )
        continue;
      const appliedSeries =
        applied.dataVersion?.label === contract.label && applied.dataVersion.target === contract.target
          ? applied.dataVersion.series
          : undefined;
      if (appliedSeries?.image === series.image) continue;
      const runtime = yield* provider;
      const observation = yield* versionEvidence({
        provider: runtime,
        appliedPlan,
        service: applied,
        mount: previousMount,
        contract,
        series,
        appliedSeries: appliedSeries?.image,
      });
      if (observation === undefined) continue;
      const evidence = typeof observation === "string" ? undefined : observation;
      const from = evidence?.version ?? appliedSeries?.image;
      if (from === undefined) continue;
      const to = series.image;
      const comparison = compareDataSeries(from, to, series.depth);
      if (comparison === undefined || comparison === 0) continue;
      if (observation === "stopped" && comparison === 1 && series.upgrade === "in-place") {
        stoppedChecks.push({
          service: service.name,
          target: contract.target,
          store: mount.store,
          appliedPlan,
          label: contract.label,
          from,
          to,
          source: "applied-plan",
        });
      }
      if (comparison === -1 && series.upgrade === "in-place") {
        if (upgrade === undefined || compareDataSeries(from, upgrade.from, series.depth) === 1)
          upgrade = {
            service: service.name,
            target: contract.target,
            store: mount.store,
            appliedPlan,
            label: contract.label,
            from,
            to,
            source: evidence?.source ?? "applied-plan",
          };
        continue;
      }
      if (evidence === undefined) continue;
      const finding = {
        direction: comparison === 1 ? "downgrade" : "upgrade",
        evidence: evidence.source,
        dataVersion: from,
        imageVersion: to,
      } as const;
      return yield* refuseDataVersion({
        desired,
        appliedPlan,
        service,
        mount,
        label: contract.label,
        depth: series.depth,
        providerId: runtime.id,
        finding,
        generation: evidence.generation,
      });
    }
    if (upgrade !== undefined) dataUpgrades.push(upgrade);
  }
  return { dataUpgrades, stoppedChecks };
});

export const publishDataUpgradeNotices = Effect.fnUntraced(function* (dataUpgrades: readonly DataUpgrade[]) {
  if (dataUpgrades.length === 0) return;
  const events = yield* EventService;
  for (const { service, from, to, label } of dataUpgrades)
    yield* events.publish(
      MessageInfoEvent.make({
        body: `Moving ${service} from ${label} ${from} to ${to} on its existing data.`,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
});
