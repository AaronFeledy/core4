import { type AppPlan, PortablePath, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";

const dataTarget = PortablePath.make("/var/lib/mysql");
const store = "version-test-data";

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
      artifact: { kind: "ref", ref: `mariadb:${image}` },
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
    service,
    providerId: plan.provider,
    status: "running",
    containerId: "database-original",
    publications: { status: "unknown" },
  }) satisfies ServiceRuntimeInfo;
