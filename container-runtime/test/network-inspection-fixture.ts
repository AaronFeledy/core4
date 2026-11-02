import type { AppPlan } from "@lando/sdk/schema";
import { networkOwnershipLabels } from "../src/native-ownership.ts";

export const ownedNetworkInspection = (plan: AppPlan, name: string) => ({
  Id: `id-${name}`,
  Name: name,
  Driver:
    plan.networking?.perAppBridge?.name === name
      ? (plan.networking.perAppBridge.driver ?? "bridge")
      : "bridge",
  Labels: networkOwnershipLabels(plan),
});
