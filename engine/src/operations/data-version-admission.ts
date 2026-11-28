import { dataVersionRemediation } from "@lando/container-runtime/data-version-diagnostic";
import { ServiceDataVersionError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type PortablePath,
  type ServiceDataVersion,
  type ServiceName,
  type ServicePlan,
  compareDataSeries,
  parseDataVersionRecords,
} from "@lando/sdk/schema";
import { EventService, type ProviderError } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";

export interface DataUpgrade {
  readonly service: ServiceName;
  readonly target: PortablePath;
  readonly store: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly source: Evidence["source"] | "applied-plan";
}

type Evidence = { readonly version: string; readonly source: "record" | "running-image" };
type Series = NonNullable<ServiceDataVersion["series"]>;

const dataMount = (service: ServicePlan, target: PortablePath) =>
  service.mounts.find((mount) => mount.type === "volume" && mount.target === target);

const versionEvidence = Effect.fnUntraced(function* (input: {
  readonly provider: PreparedRuntimeProvider;
  readonly appliedPlan: AppPlan;
  readonly service: ServiceName;
  readonly contract: ServiceDataVersion;
  readonly series: Series;
  readonly appliedSeries: string | undefined;
}) {
  const { provider, appliedPlan, service, contract, series, appliedSeries } = input;
  const target = { app: appliedPlan.id, service, plan: appliedPlan };
  const runtime = yield* provider.inspect(target).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (runtime?.status !== "running" || runtime.containerId === undefined) return undefined;
  const paths = series.records.map(({ path }) => path);
  // Read each file at most up to 4 KiB (+1 to recognize truncation), with one pinned exec.
  const read = yield* provider
    .exec(
      { ...target, expectedContainerId: runtime.containerId },
      {
        command: [
          "sh",
          "-c",
          `for file do head -c 4097 -- "$file" 2>/dev/null; printf '\\000'; done`,
          "lando-data-version",
          ...paths,
        ],
        raw: true,
      },
    )
    .pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  if (read === undefined || read.exitCode !== 0) return undefined;
  const contents = read.stdout.split("\0");
  if (contents.length !== paths.length + 1 || contents.at(-1) !== "") return undefined;
  const files = new Map<string, string>();
  for (const [index, path] of paths.entries()) {
    const content = contents[index];
    if (content !== undefined && Buffer.byteLength(content) <= 4096) files.set(path, content);
  }
  const version = parseDataVersionRecords(files, contract);
  if (
    runtime.health === "healthy" &&
    appliedSeries !== undefined &&
    (version === undefined || compareDataSeries(appliedSeries, version, series.depth) === 1)
  )
    return { version: appliedSeries, source: "running-image" } satisfies Evidence;
  return version === undefined ? undefined : ({ version, source: "record" } satisfies Evidence);
});

export const assessDataVersions = Effect.fn("AppActivation.assessDataVersions")(function* (
  desired: AppPlan,
  appliedPlans: readonly AppPlan[],
  provider: Effect.Effect<PreparedRuntimeProvider, ProviderError>,
) {
  const dataUpgrades: DataUpgrade[] = [];
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
      const evidence = yield* versionEvidence({
        provider: runtime,
        appliedPlan,
        service: service.name,
        contract,
        series,
        appliedSeries: appliedSeries?.image,
      });
      const from = evidence?.version ?? appliedSeries?.image;
      if (from === undefined) continue;
      const to = series.image;
      const comparison = compareDataSeries(from, to, series.depth);
      if (comparison === undefined || comparison === 0) continue;
      if (comparison === -1 && series.upgrade === "in-place") {
        if (upgrade === undefined || compareDataSeries(from, upgrade.from, series.depth) === 1)
          upgrade = {
            service: service.name,
            target: contract.target,
            store: mount.store,
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
      return yield* new ServiceDataVersionError({
        app: desired.name,
        service: service.name,
        providerId: runtime.id,
        image: service.artifact?.kind === "ref" ? service.artifact.ref : to,
        ...(applied.artifact?.kind === "ref" ? { appliedImage: applied.artifact.ref } : {}),
        dataVersion: finding,
        message: `Service ${service.name}: ${contract.label} ${to} cannot open data written by ${contract.label} ${from}.`,
        remediation: dataVersionRemediation(desired, service, { finding }),
      });
    }
    if (upgrade !== undefined) dataUpgrades.push(upgrade);
  }
  return dataUpgrades;
});

export const publishDataUpgradeNotices = Effect.fnUntraced(function* (dataUpgrades: readonly DataUpgrade[]) {
  if (dataUpgrades.length === 0) return;
  const events = yield* EventService;
  for (const { service, from, to, label } of dataUpgrades)
    yield* events.publish(
      MessageInfoEvent.make({
        body: `Upgrading ${service} data from ${label} ${from} to ${to} in place.`,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
});
