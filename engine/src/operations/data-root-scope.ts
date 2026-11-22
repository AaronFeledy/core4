import { type AdoptionReceipt, decideDataRootOwnership } from "@lando/container-runtime/native-ownership";
import { type AppPlan, LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import { PathsService, type ProviderRuntimeSnapshot, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";

export const currentDataRoot = Effect.flatMap(PathsService, (paths) =>
  canonicalMissingAppRoot(paths.roots.userDataRoot),
);

export const localAppliedRecord = (plan: Pick<AppPlan, "identity">, dataRoot: string): boolean =>
  plan.identity?.dataRoot === undefined || plan.identity.dataRoot === dataRoot;

export const serviceInDataRoot = (
  service: ServiceRuntimeInfo,
  dataRoot: string | undefined,
  receipts: readonly AdoptionReceipt[],
): boolean =>
  dataRoot === undefined
    ? service.labels?.[LANDO_DATA_ROOT_LABEL] === undefined
    : decideDataRootOwnership(
        {
          kind: "container",
          nativeName: service.nativeName ?? "",
          nativeId: service.containerId,
          labels: service.labels,
        },
        {
          dataRoot,
          receipts: receipts.filter(
            (receipt) =>
              receipt.providerId === service.providerId &&
              receipt.appRoot === service.appRoot &&
              receipt.appId === service.app,
          ),
        },
      ) === "owned";

export const scopeRuntimeSnapshot = <
  Snapshot extends Pick<ProviderRuntimeSnapshot, "services" | "volumes"> &
    Partial<Pick<ProviderRuntimeSnapshot, "appliedPlans">>,
>(
  snapshot: Snapshot,
  dataRoot: string,
  receipts: readonly AdoptionReceipt[] = [],
): Snapshot => ({
  ...snapshot,
  ...(snapshot.appliedPlans === undefined
    ? {}
    : { appliedPlans: snapshot.appliedPlans.filter((plan) => localAppliedRecord(plan, dataRoot)) }),
  services: snapshot.services.filter((service) => serviceInDataRoot(service, dataRoot, receipts)),
  volumes: snapshot.volumes.filter((volume) => {
    const identity = volume.identity;
    return (
      identity !== undefined &&
      decideDataRootOwnership(
        {
          kind: "volume",
          nativeName: identity.nativeName,
          labels: volume.labels,
          volumeInstance: volume.labels?.["dev.lando.volume-instance"],
        },
        {
          dataRoot,
          receipts: receipts.filter(
            (receipt) => receipt.appRoot === identity.ownerRoot && receipt.appId === volume.ref.app,
          ),
        },
      ) === "owned"
    );
  }),
});
