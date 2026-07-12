import { Effect, Ref, Scope } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, HostPlatform, ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";
import { type EventService, PathsService, type RootOverrides, type ShellRunner } from "@lando/sdk/services";

import { makeLandoPaths } from "../../config/paths.ts";
import type { RedactionService } from "../../redaction/service.ts";
import {
  type HostProxyShimTarget,
  defaultHostProxyShimArtifactPath,
} from "../../subsystems/host-proxy/transport-shim.ts";
import {
  type HostProxyRunLandoSession,
  hostProxyRunLandoFeature,
} from "../../subsystems/host-proxy/transport.ts";
import {
  hostProxyEligibleServices,
  serviceHasHostProxyFeature,
  startDetachedHostProxyWorker,
} from "../../subsystems/host-proxy/worker.ts";

const HOST_PROXY_CONTAINER_TARGET_CAPABILITY = "ProviderCapabilities.hostProxy.containerTargets";
const HOST_PROXY_HOST_GATEWAY_CAPABILITY = "ProviderCapabilities.hostProxy.tcpHostGateway";

const targetKey = (target: HostProxyShimTarget): string => `${target.os}-${target.arch}`;

const hostProxyShimTargetFor = (
  capabilities: ProviderCapabilities,
): Effect.Effect<HostProxyShimTarget, HostProxyTransportUnavailableError> => {
  const providerTargets = capabilities.hostProxy?.containerTargets ?? [];
  if (providerTargets.length === 0) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Host-proxy requires a provider-declared eligible Linux container target.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_CAPABILITY,
        remediation: "Select a provider that advertises one Linux x64 or arm64 host-proxy container target.",
      }),
    );
  }
  const uniqueProviderTargets = new Map(providerTargets.map((target) => [targetKey(target), target]));
  if (uniqueProviderTargets.size > 1) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Provider declared conflicting host-proxy container targets.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_CAPABILITY,
        remediation: "Select a provider that advertises exactly one host-proxy Linux container target.",
      }),
    );
  }
  const target = uniqueProviderTargets.values().next().value;
  if (target === undefined) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Host-proxy requires a provider-declared eligible Linux container target.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_CAPABILITY,
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

const validateHostProxyTransportCapability = (
  platform: HostPlatform,
  capabilities: ProviderCapabilities,
): Effect.Effect<string | undefined, HostProxyTransportUnavailableError> => {
  if (platform !== "win32") return Effect.succeed(undefined);
  const hostGatewayName = capabilities.hostProxy?.tcpHostGateway;
  if (hostGatewayName !== undefined) return Effect.succeed(hostGatewayName);
  return Effect.fail(
    new HostProxyTransportUnavailableError({
      message: "Provider cannot realize the host-proxy TCP host-gateway transport for Linux containers.",
      socketPath: HOST_PROXY_HOST_GATEWAY_CAPABILITY,
      remediation: "Select a Windows provider that advertises host-proxy TCP host-gateway support.",
    }),
  );
};

export const startHostProxyRunLandoSession = (
  plan: AppPlan,
  app: AppRef,
  capabilities: ProviderCapabilities,
  options: RootOverrides = {},
) =>
  Effect.gen(function* () {
    yield* Effect.context<ShellRunner | EventService | RedactionService>();
    const eligibleServices = hostProxyEligibleServices(plan);
    if (capabilities.hostReachability === "none" || eligibleServices.length === 0) return undefined;
    if ((capabilities.hostProxy?.containerTargets.length ?? 0) === 0) return undefined;
    const shimTarget = yield* hostProxyShimTargetFor(capabilities);
    const landoPaths = makeLandoPaths(options);
    const platform = landoPaths.platform;
    const hostGatewayName = yield* validateHostProxyTransportCapability(platform, capabilities);
    return yield* startDetachedHostProxyWorker({
      app,
      plan,
      paths: { ...landoPaths.roots, platform },
      shimArtifactPath: defaultHostProxyShimArtifactPath({ target: shimTarget }),
      shimTarget,
      ...(hostGatewayName === undefined ? {} : { hostGatewayName }),
    });
  });

export const withStartedHostProxy = <A, E, R>(
  plan: AppPlan,
  app: AppRef,
  capabilities: ProviderCapabilities,
  options: {
    readonly platform?: HostPlatform;
    readonly managed?: { readonly scope: Scope.Scope };
    readonly use: (plan: AppPlan) => Effect.Effect<A, E, R>;
  },
): Effect.Effect<
  A,
  E | HostProxyTransportUnavailableError,
  R | ShellRunner | EventService | RedactionService | PathsService
> =>
  Effect.gen(function* () {
    const paths = yield* PathsService;
    const keepSession = yield* Ref.make(false);
    return yield* Effect.acquireUseRelease(
      startHostProxyRunLandoSession(plan, app, capabilities, {
        ...paths.roots,
        platform: options.platform ?? paths.platform,
      }),
      (session) => {
        const applyPlan = session === undefined ? plan : withHostProxyRunLando(plan, session);
        return options
          .use(applyPlan)
          .pipe(
            Effect.tap(() =>
              Ref.set(keepSession, true).pipe(
                Effect.zipRight(
                  session === undefined || options.managed === undefined
                    ? Effect.void
                    : Effect.addFinalizer(() => Effect.promise(() => session.close())).pipe(
                        Effect.provideService(Scope.Scope, options.managed.scope),
                      ),
                ),
              ),
            ),
          );
      },
      (session) =>
        Ref.get(keepSession).pipe(
          Effect.flatMap((keep) =>
            keep || session === undefined ? Effect.void : Effect.promise(() => session.close()),
          ),
        ),
    );
  });
