import type { AppPlan, EndpointInfo, EndpointPlan, ProviderId, RoutePlan } from "@lando/sdk/schema";

import { HOST_INTERNAL_ALIAS } from "../subsystems/networking.ts";

export { HOST_INTERNAL_ALIAS };

export interface PublishedProxyTarget {
  readonly service: string;
  readonly containerPort: number;
  readonly hostPort: number;
}

export const usesHostProxyNetwork = (input: {
  readonly provider: ProviderId;
  readonly hostProvider: ProviderId;
  readonly sharedCrossAppNetwork: boolean;
}): boolean => input.provider === input.hostProvider && input.sharedCrossAppNetwork;

export const promoteRoutableEndpointsForHostProxy = (
  endpoints: ReadonlyArray<EndpointPlan>,
): ReadonlyArray<EndpointPlan> =>
  endpoints.map((endpoint) => {
    if (endpoint._tag !== "internal") return endpoint;
    if (endpoint.protocol !== "http" && endpoint.protocol !== "https") return endpoint;
    return {
      _tag: "published",
      protocol: endpoint.protocol,
      port: endpoint.port,
      publication: { bindAddress: "0.0.0.0" },
      ...(endpoint.name === undefined ? {} : { name: endpoint.name }),
    };
  });

export const publishedTargetsFromEndpoints = (
  service: string,
  endpoints: ReadonlyArray<EndpointInfo>,
): ReadonlyArray<PublishedProxyTarget> =>
  endpoints.flatMap((endpoint) => {
    if (endpoint._tag !== "published") return [];
    const hostPort = endpoint.materialization?.hostPort ?? endpoint.publication.hostPort;
    if (hostPort === undefined) return [];
    return [{ service, containerPort: endpoint.port, hostPort }];
  });

export const rewriteCrossEngineProxyRoutes = (input: {
  readonly plan: Pick<AppPlan, "provider" | "routes">;
  readonly published: ReadonlyArray<PublishedProxyTarget>;
  readonly hostProvider: ProviderId;
  readonly sharedCrossAppNetwork: boolean;
}): ReadonlyArray<RoutePlan> => {
  if (usesHostProxyNetwork({ ...input, provider: input.plan.provider })) return input.plan.routes;
  return input.plan.routes.map((route) => {
    const match = input.published.find(
      (target) =>
        target.service === String(route.backend.service) && target.containerPort === route.backend.port,
    );
    if (match === undefined) return route;
    return {
      ...route,
      backend: {
        ...route.backend,
        host: HOST_INTERNAL_ALIAS,
        port: match.hostPort,
      },
    };
  });
};
