import type { AppPlan, ServicePlan } from "@lando/sdk/schema";

import type { HostProxyMountInfo } from "./cwd-remap.ts";

const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
const HOST_PROXY_FEATURE_ID = "lando.host-proxy";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const serviceHasHostProxyFeature = (service: ServicePlan): boolean => {
  const extension = service.extensions[SERVICE_FEATURES_EXTENSION_KEY];
  if (!isRecord(extension)) return false;
  const featureIds = extension.featureIds;
  return Array.isArray(featureIds) && featureIds.includes(HOST_PROXY_FEATURE_ID);
};

export const hostProxyEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasHostProxyFeature);

export const hostProxyMountInfoFromPlan = (plan: AppPlan): HostProxyMountInfo => {
  for (const service of hostProxyEligibleServices(plan)) {
    if (service.appMount !== undefined)
      return { containerRoot: String(service.appMount.target), hostRoot: String(service.appMount.source) };
  }
  return { containerRoot: "/app", hostRoot: String(plan.root) };
};
