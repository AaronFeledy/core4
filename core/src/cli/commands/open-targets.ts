import { Schema } from "effect";

import type { AppPlan, EndpointPlan, RoutePlan, ServicePlan } from "@lando/sdk/schema";

import {
  type HttpScheme,
  endpointHostname,
  endpointUrl,
  formatAuthorityUrl,
  routeSchemes,
  routeUrl,
} from "../authority-url.ts";

export const OpenTargetSchema = Schema.Struct({
  service: Schema.String,
  hostname: Schema.String,
  scheme: Schema.Literal("http", "https"),
  url: Schema.String,
});
export type OpenTarget = typeof OpenTargetSchema.Type;

export interface OpenTargetSelection {
  readonly service?: string;
  readonly route?: string;
  readonly all?: boolean;
}

type ResolvablePlan = Pick<AppPlan, "services" | "routes">;

const OPENABLE_SCHEMES = new Set(["http:", "https:"]);

export const isOpenableScheme = (url: string): boolean => {
  try {
    return OPENABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

const openTargetForScheme = (route: RoutePlan, scheme: HttpScheme): OpenTarget => ({
  service: String(route.service),
  hostname: route.hostname,
  scheme,
  url: formatAuthorityUrl(routeUrl(route, scheme)),
});

export const buildOpenTarget = (route: RoutePlan): OpenTarget =>
  openTargetForScheme(route, routeSchemes(route, false)[0] ?? "https");

const buildOpenTargets = (route: RoutePlan): ReadonlyArray<OpenTarget> =>
  routeSchemes(route, true).map((scheme) => openTargetForScheme(route, scheme));

const endpointOpenTarget = (service: ServicePlan, endpoint: EndpointPlan): OpenTarget | undefined => {
  if ((endpoint.protocol !== "http" && endpoint.protocol !== "https") || endpoint.port === undefined)
    return undefined;
  return {
    service: String(service.name),
    hostname: endpointHostname(endpoint),
    scheme: endpoint.protocol,
    url: formatAuthorityUrl(endpointUrl(endpoint, endpoint.protocol)),
  };
};

const routesForService = (plan: ResolvablePlan, service: string): RoutePlan[] =>
  plan.routes.filter((route) => String(route.service) === service);

const preferHttps = (routes: ReadonlyArray<RoutePlan>): RoutePlan | undefined =>
  routes.find((route) => route.scheme === "https" || route.scheme === "both") ?? routes[0];

const endpointTargetsForService = (plan: ResolvablePlan, serviceName: string): OpenTarget[] => {
  const service = Object.values(plan.services).find((candidate) => String(candidate.name) === serviceName);
  if (service === undefined) return [];
  return service.endpoints.flatMap((endpoint) => {
    const target = endpointOpenTarget(service, endpoint);
    return target === undefined ? [] : [target];
  });
};

const preferHttpsTarget = (targets: ReadonlyArray<OpenTarget>): OpenTarget | undefined =>
  targets.find((target) => target.scheme === "https") ?? targets[0];

export const resolveOpenTargets = (
  plan: ResolvablePlan,
  selection: OpenTargetSelection,
): ReadonlyArray<OpenTarget> => {
  if (selection.route !== undefined) {
    const match = plan.routes.find((route) => route.hostname === selection.route);
    return match === undefined ? [] : [buildOpenTarget(match)];
  }
  if (selection.service !== undefined) {
    const serviceRoutes = routesForService(plan, selection.service);
    if (selection.all === true && serviceRoutes.length > 0) return serviceRoutes.flatMap(buildOpenTargets);
    const chosen = preferHttps(serviceRoutes);
    if (chosen !== undefined) return [buildOpenTarget(chosen)];
    const endpoints = endpointTargetsForService(plan, selection.service);
    if (selection.all === true) return endpoints;
    const endpoint = preferHttpsTarget(endpoints);
    return endpoint === undefined ? [] : [endpoint];
  }
  if (selection.all === true) {
    if (plan.routes.length > 0) return plan.routes.flatMap(buildOpenTargets);
    return Object.values(plan.services).flatMap((service) =>
      endpointTargetsForService(plan, String(service.name)),
    );
  }
  for (const service of Object.values(plan.services)) {
    const routes = routesForService(plan, String(service.name));
    const chosen = preferHttps(routes);
    if (chosen !== undefined) return [buildOpenTarget(chosen)];
  }
  for (const service of Object.values(plan.services)) {
    const endpoint = preferHttpsTarget(endpointTargetsForService(plan, String(service.name)));
    if (endpoint !== undefined) return [endpoint];
  }
  return [];
};
