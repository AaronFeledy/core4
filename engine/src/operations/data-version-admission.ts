import { dataVersionRemediation } from "@lando/container-runtime/data-version-diagnostic";
import { ServiceDataVersionError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type PortablePath,
  type ServiceDataVersion,
  type ServiceName,
  type ServicePlan,
  type VolumeMountPlan,
  compareDataSeries,
  parseDataVersionRecords,
  planAppIdentity,
} from "@lando/sdk/schema";
import { EventService, type ProviderError } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";

export interface DataUpgrade {
  readonly service: ServiceName;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly source: Evidence["source"] | "applied-plan";
}

type Evidence = { readonly version: string; readonly source: "record" | "running-image" };
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
      runtime.status !== "running" ||
      !runtime.containerId ||
      runtime.app !== target.app ||
      runtime.appRoot !== root ||
      runtime.providerId !== appliedPlan.provider ||
      runtime.service !== service.name ||
      mount.subpath !== undefined ||
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
      volume.ref.store !== mount.store ||
      volume.identity?.nativeName !== mount.store ||
      volume.identity.ownerRoot !== root
    )
      return undefined;

    // Read each file at most up to 4 KiB (+1 to recognize truncation), with one pinned exec.
    const read = yield* provider.exec(bound, {
      command: [
        "sh",
        "-c",
        `for file do
        test -x "\${file%/*}" || exit 1
        resolved=$(readlink -f -- "$file") && test "$resolved" = "$file" || exit 1
        if test -e "$file" || test -L "$file"; then
          test -f "$file" && test ! -L "$file" || exit 1
          printf '+'
          head -c 4097 -- "$file" || exit 1
        else
          printf '-'
        fi
        printf '\\000'
      done`,
        "lando-data-version",
        ...paths,
      ],
      raw: true,
    });
    if (read.exitCode !== 0) return undefined;
    const contents = read.stdout.split("\0");
    if (contents.length !== paths.length + 1 || contents.at(-1) !== "") return undefined;
    const files = new Map<string, string>();
    for (const [index, path] of paths.entries()) {
      const frame = contents[index];
      if (frame === "-") continue;
      if (frame?.startsWith("+") !== true) return undefined;
      const content = frame.slice(1);
      if (Buffer.byteLength(content) <= 4096) files.set(path, content);
    }
    const version = parseDataVersionRecords(files, contract);
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
      (version === undefined
        ? contents.slice(0, -1).every((frame) => frame === "-")
        : compareDataSeries(appliedSeries, version, series.depth) === 1)
    )
      return { version: appliedSeries, source: "running-image" } satisfies Evidence;
    return version === undefined ? undefined : ({ version, source: "record" } satisfies Evidence);
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
        service: applied,
        mount: previousMount,
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
