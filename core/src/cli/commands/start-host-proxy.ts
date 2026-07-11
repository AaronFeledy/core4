import { Effect } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, HostPlatform, ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";
import type { EventService, ShellRunner } from "@lando/sdk/services";

import { makeLandoPaths } from "../../config/paths.ts";
import type { RedactionService } from "../../redaction/service.ts";
import {
  type HostProxyShimTarget,
  defaultHostProxyShimArtifactPath,
  hostProxyShimTargetsFromProviderExtensions,
  hostProxyTcpGatewayHostFromProviderExtensions,
} from "../../subsystems/host-proxy/transport-shim.ts";
import {
  type HostProxyRunLandoSession,
  hostProxyRunLandoFeature,
} from "../../subsystems/host-proxy/transport.ts";
import { startDetachedHostProxyWorker } from "../../subsystems/host-proxy/worker.ts";

const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
const HOST_PROXY_FEATURE_ID = "lando.host-proxy";
const HOST_PROXY_CONTAINER_TARGET_EXTENSION_KEY = "@lando/core/host-proxy-container-target";
const HOST_PROXY_HOST_GATEWAY_EXTENSION = "@lando/core/host-proxy-transport:tcp-host-gateway";

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

const targetKey = (target: HostProxyShimTarget): string => `${target.os}-${target.arch}`;

const hostProxyShimTargetFor = (
  capabilities: ProviderCapabilities,
): Effect.Effect<HostProxyShimTarget, HostProxyTransportUnavailableError> => {
  const providerTargets = hostProxyShimTargetsFromProviderExtensions(capabilities.providerExtensions);
  if (providerTargets.length === 0) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Host-proxy requires a provider-declared eligible Linux container target.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_EXTENSION_KEY,
        remediation: "Select a provider that advertises one Linux x64 or arm64 host-proxy container target.",
      }),
    );
  }
  const uniqueProviderTargets = new Map(providerTargets.map((target) => [targetKey(target), target]));
  if (uniqueProviderTargets.size > 1) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Provider declared conflicting host-proxy container targets.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_EXTENSION_KEY,
        remediation: "Select a provider that advertises exactly one host-proxy Linux container target.",
      }),
    );
  }
  const target = uniqueProviderTargets.values().next().value;
  if (target === undefined) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Host-proxy requires a provider-declared eligible Linux container target.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_EXTENSION_KEY,
        remediation: "Select a provider that advertises one Linux x64 or arm64 host-proxy container target.",
      }),
    );
  }
  return Effect.succeed(target);
};

export const withHostProxyRunLando = (plan: AppPlan, session: HostProxyRunLandoSession): AppPlan => {
  const feature = hostProxyRunLandoFeature(session);
  const services = Object.fromEntries(
    Object.values(plan.services).map((service) => {
      if (!serviceHasHostProxyFeature(service)) return [service.name, service];
      const environment = Object.entries(service.environment);
      const mounts: Array<ServicePlan["mounts"][number]> = [...service.mounts];
      const extensions = { ...service.extensions };
      feature.apply({
        addEnv: (name, value) => {
          environment.push([name, value]);
        },
        addMount: (mount) => {
          mounts.push(mount);
        },
        addExtension: (name, value) => {
          extensions[name] = value;
        },
      });
      return [service.name, { ...service, environment: Object.fromEntries(environment), mounts, extensions }];
    }),
  );
  return { ...plan, services };
};

const validateHostProxyTransportCapability = (
  platform: HostPlatform,
  capabilities: ProviderCapabilities,
): Effect.Effect<string | undefined, HostProxyTransportUnavailableError> => {
  if (platform !== "win32") return Effect.succeed(undefined);
  const hostGatewayName = hostProxyTcpGatewayHostFromProviderExtensions(capabilities.providerExtensions);
  if (hostGatewayName !== undefined) return Effect.succeed(hostGatewayName);
  return Effect.fail(
    new HostProxyTransportUnavailableError({
      message: "Provider cannot realize the host-proxy TCP host-gateway transport for Linux containers.",
      socketPath: HOST_PROXY_HOST_GATEWAY_EXTENSION,
      remediation: "Select a Windows provider that advertises host-proxy TCP host-gateway support.",
    }),
  );
};

export const startHostProxyRunLandoSession = (
  plan: AppPlan,
  app: AppRef,
  capabilities: ProviderCapabilities,
  options: { readonly platform?: HostPlatform } = {},
) =>
  Effect.gen(function* () {
    yield* Effect.context<ShellRunner | EventService | RedactionService>();
    const eligibleServices = hostProxyEligibleServices(plan);
    if (capabilities.hostReachability === "none" || eligibleServices.length === 0) return undefined;
    const shimTarget = yield* hostProxyShimTargetFor(capabilities);
    const platform = options.platform ?? makeLandoPaths().platform;
    const hostGatewayName = yield* validateHostProxyTransportCapability(platform, capabilities);
    return yield* startDetachedHostProxyWorker({
      app,
      plan,
      paths: { platform },
      shimArtifactPath: defaultHostProxyShimArtifactPath({ target: shimTarget }),
      shimTarget,
      ...(hostGatewayName === undefined ? {} : { hostGatewayName }),
    });
  });
