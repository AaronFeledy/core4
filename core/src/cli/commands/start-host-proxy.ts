import { Effect } from "effect";

import type { AppPlan, AppRef, ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";
import type { EventService, ShellRunner } from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import { defaultHostProxyShimArtifactPath } from "../../subsystems/host-proxy/transport-shim.ts";
import {
  type HostProxyRunLandoSession,
  hostProxyRunLandoFeature,
} from "../../subsystems/host-proxy/transport.ts";
import { startDetachedHostProxyWorker } from "../../subsystems/host-proxy/worker.ts";

const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
const HOST_PROXY_FEATURE_ID = "lando.host-proxy";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serviceFeatureIds = (service: ServicePlan): ReadonlyArray<string> => {
  const extension = service.extensions[SERVICE_FEATURES_EXTENSION_KEY];
  if (!isRecord(extension)) return [];
  const featureIds = extension.featureIds;
  return Array.isArray(featureIds) ? featureIds.filter((id): id is string => typeof id === "string") : [];
};

const serviceHasHostProxyFeature = (service: ServicePlan): boolean =>
  serviceFeatureIds(service).includes(HOST_PROXY_FEATURE_ID);

export const hostProxyEligibleServices = (plan: AppPlan): ReadonlyArray<ServicePlan> =>
  Object.values(plan.services).filter(serviceHasHostProxyFeature);

export const withHostProxyRunLando = (plan: AppPlan, session: HostProxyRunLandoSession): AppPlan => {
  const feature = hostProxyRunLandoFeature(session);
  const services = Object.fromEntries(
    Object.values(plan.services).map((service) => {
      if (!serviceHasHostProxyFeature(service)) return [service.name, service];
      const environment = Object.entries(service.environment);
      const mounts: Array<ServicePlan["mounts"][number]> = [...service.mounts];
      feature.apply({
        addEnv: (name, value) => {
          environment.push([name, value]);
        },
        addMount: (mount) => {
          mounts.push(mount);
        },
      });
      return [service.name, { ...service, environment: Object.fromEntries(environment), mounts }];
    }),
  );
  return { ...plan, services };
};

export const startHostProxyRunLandoSession = (
  plan: AppPlan,
  app: AppRef,
  capabilities: ProviderCapabilities,
) =>
  Effect.gen(function* () {
    yield* Effect.context<ShellRunner | EventService | RedactionService>();
    if (capabilities.hostReachability === "none" || hostProxyEligibleServices(plan).length === 0)
      return undefined;
    return yield* startDetachedHostProxyWorker({
      app,
      plan,
      shimArtifactPath: defaultHostProxyShimArtifactPath(),
    });
  });
