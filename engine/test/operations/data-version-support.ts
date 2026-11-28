import {
  type AppPlan,
  PortablePath,
  type ServicePlan,
  type VolumeInfo,
  planAppIdentity,
  planDataId,
} from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";

const dataTarget = PortablePath.make("/var/lib/mysql");
const store = "version-test-data";
const digest = `sha256:${"1".repeat(64)}`;

export const versionedPlan = (
  plan: AppPlan,
  base: ServicePlan,
  image: string,
  upgrade: "in-place" | "unsupported" = "in-place",
): AppPlan => ({
  ...plan,
  services: {
    ...plan.services,
    [base.name]: {
      ...base,
      serviceTypeId: `mariadb:${image}`,
      artifact: { kind: "ref", ref: `mariadb:${image}`, digest },
      mounts: [...base.mounts, { type: "volume", target: dataTarget, store, readOnly: false }],
      dataVersion: {
        target: dataTarget,
        label: "MariaDB",
        series: {
          image,
          depth: 2,
          records: [
            {
              path: PortablePath.make(`${dataTarget}/mariadb_upgrade_info`),
              pattern: String.raw`^(\d+\.\d+\.\d+)`,
            },
          ],
          upgrade,
        },
        refusals: [],
      },
    },
  },
  stores: [...plan.stores, { kind: "data", scope: "service", name: store }],
});

export const databaseRuntime = (plan: AppPlan, service: ServicePlan["name"]) =>
  ({
    app: plan.id,
    appRoot: planAppIdentity(plan).appRoot,
    service,
    providerId: plan.provider,
    status: "running",
    containerId: "database-original",
    imageIdentity: digest,
    publications: { status: "unknown" },
  }) satisfies ServiceRuntimeInfo;

export const databaseVolume = (plan: AppPlan, nativeName = store): VolumeInfo => ({
  ref: { app: planDataId(plan), store: nativeName },
  identity: {
    nativeName,
    ownerRoot: planAppIdentity(plan).appRoot,
    coordinationKey: "database-volume-lock",
    generation: "database-volume-generation",
    origin: "created",
  },
});
