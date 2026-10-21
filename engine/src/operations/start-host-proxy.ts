import { Effect, type Scope } from "effect";

import { type ContainerHelperUnavailableError, HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, HostPlatform, ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";
import { EventService, PathsService, type RootOverrides, type ShellRunner } from "@lando/sdk/services";
import { makeTaskTree, runWithTaskTree } from "@lando/sdk/task-progress";

import { makeLandoPaths } from "@lando/paths";
import type { RedactionService } from "@lando/redaction/service";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { resolveContainerHelper } from "../composition.ts";
import type { HostProxyShimTarget } from "../subsystems/host-proxy/transport-shim.ts";
import {
  type HostProxyRunLandoSession,
  hostProxyRunLandoFeature,
} from "../subsystems/host-proxy/transport.ts";
import {
  hostProxyEligibleServices,
  serviceHasHostProxyFeature,
  startDetachedHostProxyWorker,
} from "../subsystems/host-proxy/worker.ts";
import { type PublishSession, withRetainedSession } from "./retained-session.ts";
import { startHostProxyTreeId } from "./start-progress.ts";

const HOST_PROXY_CONTAINER_TARGET_CAPABILITY = "ProviderCapabilities.hostProxy.containerTargets";
const HOST_PROXY_HOST_GATEWAY_CAPABILITY = "ProviderCapabilities.hostProxy.tcpHostGateway";

const targetKey = (target: HostProxyShimTarget): string => `${target.os}-${target.arch}`;

const helperUnavailable = (error: ContainerHelperUnavailableError): HostProxyTransportUnavailableError =>
  new HostProxyTransportUnavailableError({
    message: error.message,
    socketPath: `container-helper:${targetKey(error.target)}`,
    remediation: error.remediation,
  });

const hostProxyShimTargetFor = (
  capabilities: ProviderCapabilities,
): Effect.Effect<HostProxyShimTarget, HostProxyTransportUnavailableError> => {
  const providerTargets = capabilities.hostProxy?.containerTargets ?? [];
  const [target, ...remainingTargets] = providerTargets;
  if (target === undefined) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Host-proxy requires a provider-declared eligible Linux container target.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_CAPABILITY,
        remediation: "Select a provider that advertises one Linux x64 or arm64 host-proxy container target.",
      }),
    );
  }
  const selectedTargetKey = targetKey(target);
  if (remainingTargets.some((candidate) => targetKey(candidate) !== selectedTargetKey)) {
    return Effect.fail(
      new HostProxyTransportUnavailableError({
        message: "Provider declared conflicting host-proxy container targets.",
        socketPath: HOST_PROXY_CONTAINER_TARGET_CAPABILITY,
        remediation: "Select a provider that advertises exactly one host-proxy Linux container target.",
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

export const startHostProxyRunLandoSession = Effect.fnUntraced(function* (
  plan: AppPlan,
  app: AppRef,
  capabilities: ProviderCapabilities,
  options: RootOverrides & {
    readonly workerPlan?: AppPlan;
    readonly reusePolicy?: "exact" | "adopt";
    readonly managed?: { readonly scope: Scope.Scope };
  } = {},
) {
  yield* Effect.context<ShellRunner | EventService | RedactionService>();
  const eligibleServices = hostProxyEligibleServices(plan);
  if (capabilities.hostReachability === "none" || eligibleServices.length === 0) return undefined;
  if ((capabilities.hostProxy?.containerTargets.length ?? 0) === 0) return undefined;
  const shimTarget = yield* hostProxyShimTargetFor(capabilities);
  const landoPaths = makeLandoPaths(options);
  const platform = landoPaths.platform;
  const hostGatewayName = yield* validateHostProxyTransportCapability(platform, capabilities);
  const events = yield* EventService;
  const privateFileAccess = yield* PrivateFileAccessService;
  return yield* runWithTaskTree(
    makeTaskTree(events, {
      parentId: startHostProxyTreeId(String(plan.id)),
      label: `Host proxy ${plan.name}`,
      children: [{ id: "session", label: "Start host-proxy session" }],
      prefixChildIds: true,
    }),
    (tree) =>
      Effect.gen(function* () {
        yield* tree.startTask("session");
        const helper = yield* resolveContainerHelper(shimTarget, {
          cacheRoot: landoPaths.toolDownloadsDir("container-helper"),
        }).pipe(Effect.mapError(helperUnavailable));
        return yield* withRetainedSession(
          (publish: PublishSession<HostProxyRunLandoSession & { readonly reused?: boolean }>) =>
            startDetachedHostProxyWorker({
              publish,
              app,
              plan: options.workerPlan ?? plan,
              reusePolicy: options.reusePolicy ?? "exact",
              paths: { ...landoPaths.roots, platform },
              shimArtifactPath: helper.path,
              shimDigest: helper.digest,
              shimTarget,
              privateFileAccess,
              ...(hostGatewayName === undefined ? {} : { hostGatewayName }),
            }),
          (session) =>
            tree
              .completeTask(
                "session",
                session.reused ? "Host-proxy session reused" : "Host-proxy session ready",
              )
              .pipe(Effect.as(session)),
          {
            close: (session) => Effect.promise(() => session.close()),
            ...(options.managed === undefined ? {} : { scope: options.managed.scope }),
          },
        );
      }),
    {
      success: `${plan.name} host-proxy ready`,
      failure: `${plan.name} host-proxy failed`,
      interrupt: `${plan.name} host-proxy interrupted`,
    },
  );
});

export const withStartedHostProxy = Effect.fnUntraced(function* <A, E, R>(
  plan: AppPlan,
  app: AppRef,
  capabilities: ProviderCapabilities,
  options: {
    readonly platform?: HostPlatform;
    readonly managed?: { readonly scope: Scope.Scope };
    readonly workerPlan?: AppPlan;
    readonly reusePolicy?: "exact" | "adopt";
    readonly use: (plan: AppPlan) => Effect.Effect<A, E, R>;
  },
): Effect.fn.Return<
  A,
  E | HostProxyTransportUnavailableError,
  R | ShellRunner | EventService | RedactionService | PathsService | PrivateFileAccessService
> {
  const paths = yield* PathsService;
  const session = yield* startHostProxyRunLandoSession(plan, app, capabilities, {
    ...paths.roots,
    platform: options.platform ?? paths.platform,
    workerPlan: options.workerPlan ?? plan,
    reusePolicy: options.reusePolicy ?? "exact",
    ...(options.managed === undefined ? {} : { managed: options.managed }),
  });
  return yield* options.use(session === undefined ? plan : withHostProxyRunLando(plan, session));
});
