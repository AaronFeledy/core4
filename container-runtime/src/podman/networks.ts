import { type AppPlan, landoNetworkNames, landoSharedNetworkName } from "@lando/sdk/schema";

/** Global services already share the cross-app network with every app they serve. */
export const podmanNetworkNames = (plan: AppPlan): ReadonlyArray<string> => {
  const shared = landoSharedNetworkName(plan);
  if (String(plan.id) === "global" && shared !== undefined) return [shared];
  return landoNetworkNames(plan);
};
