import type { AppPlan, ServicePlan } from "@lando/sdk/schema";

export const SHARED_CROSS_APP_NETWORK = "lando_bridge_network" as const;

export const appNetworkName = (plan: AppPlan) => `lando-${plan.slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

export const networkNames = (plan: AppPlan): ReadonlyArray<string> =>
  Array.from(new Set([appNetworkName(plan), SHARED_CROSS_APP_NETWORK]));

export const serviceNetworkAliases = (plan: AppPlan, service: ServicePlan): ReadonlyArray<string> => [
  `${service.name}.${plan.slug}.internal`,
];
