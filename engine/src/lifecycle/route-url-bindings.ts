import { RouteUrlBindingError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type EnvironmentValue,
  type ProxyAuthority,
  type RoutePlan,
  type ServicePlan,
  encodeUriComponent,
} from "@lando/sdk/schema";
import type { RouterServiceShape } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { primaryConcreteRoute, routeUrl } from "../operations/connection-url.ts";
import { routeUrlConsumers } from "../planner/route-url-validation.ts";

const preparedRouteUrls = Symbol("PreparedRouteUrls");
export interface PreparedRouteUrls {
  readonly [preparedRouteUrls]: true;
  readonly routes: readonly RoutePlan[];
  readonly authorities: ReadonlyMap<string, ProxyAuthority>;
  readonly urls: ReadonlyMap<string, string>;
}

export const routeUrlRouterError = (plan: AppPlan, router: RouterServiceShape | undefined) => {
  const reference = routeUrlConsumers(plan)[0];
  return reference !== undefined && router?.routeAuthorities === undefined
    ? unsupported(reference.service)
    : undefined;
};

const noRoute = (service: string) =>
  new RouteUrlBindingError({
    reason: "no-route",
    service,
    message: `No concrete published route for ${service}.`,
    remediation:
      "Add a route with a concrete hostname or run `lando start` to publish the app's desired routes.",
  });

const unsupported = (service: string) =>
  new RouteUrlBindingError({
    reason: "router-unsupported",
    service,
    message: `No router authority was prepared for ${service}.`,
    remediation: "Select a router that reports its published authorities and run `lando start`.",
  });

/** The URL a router authority gives a route, or undefined when the router reports none for it. */
export const authorizedRouteUrl = (
  route: RoutePlan,
  authorities: readonly ProxyAuthority[],
): { readonly authority: ProxyAuthority; readonly url: string } | undefined => {
  const scheme = route.scheme === "http" ? "http" : "https";
  const authority = authorities.find(
    (candidate) =>
      candidate.scheme === scheme && candidate.hostname.toLowerCase() === route.hostname.toLowerCase(),
  );
  return authority === undefined ? undefined : { authority, url: routeUrl(route, scheme, authority.port) };
};

export const prepareRouteUrlBindings = Effect.fn("Activation.prepareRouteUrlBindings")(function* (input: {
  readonly plan: AppPlan;
  readonly routes: readonly RoutePlan[];
  readonly router?: RouterServiceShape | undefined;
  readonly retainedTargets?: ReadonlySet<string>;
  readonly appliedPlan?: AppPlan | undefined;
}) {
  const targets = [
    ...new Set([
      ...routeUrlConsumers(input.plan).map(({ service }) => service),
      ...(input.retainedTargets ?? []),
    ]),
  ];
  const first = targets[0];
  if (first === undefined) return undefined;
  const { router } = input;
  if (router?.routeAuthorities === undefined) return yield* unsupported(first);
  const available = yield* router.routeAuthorities(input.routes);
  const known = new Set([
    ...Object.keys(input.appliedPlan?.services ?? {}),
    ...Object.keys(input.plan.services),
  ]);
  const authorities = new Map<string, ProxyAuthority>();
  const urls = new Map<string, string>();
  for (const service of targets) {
    const route = known.has(service) ? primaryConcreteRoute(input.routes, service) : undefined;
    if (route === undefined) {
      if (input.retainedTargets?.has(service)) continue;
      return yield* noRoute(service);
    }
    const authorized = authorizedRouteUrl(route, available);
    if (authorized === undefined) {
      if (input.retainedTargets?.has(service)) continue;
      return yield* unsupported(service);
    }
    authorities.set(service, authorized.authority);
    urls.set(service, authorized.url);
  }
  return { [preparedRouteUrls]: true, routes: input.routes, authorities, urls } satisfies PreparedRouteUrls;
});

export const lowerRouteUrls = (
  plan: AppPlan,
  proof?: PreparedRouteUrls,
): Result.Result<AppPlan, RouteUrlBindingError> => {
  const references = routeUrlConsumers(plan);
  const first = references[0];
  if (first === undefined) return Result.succeed(plan);
  if (proof === undefined) return Result.fail(unsupported(first.service));
  const services: Record<string, ServicePlan> = {};
  for (const [name, service] of Object.entries(plan.services)) {
    const environment: Record<string, EnvironmentValue> = {};
    for (const [key, value] of Object.entries(service.environment)) {
      if (typeof value === "string" || value._tag !== "RouteText") {
        environment[key] = value;
        continue;
      }
      const parts: string[] = [];
      for (const part of value.parts) {
        if (typeof part === "string") parts.push(part);
        else {
          const url = proof.urls.get(part.service);
          if (url === undefined) return Result.fail(unsupported(part.service));
          parts.push(part.encoding === "raw" ? url : encodeUriComponent(url));
        }
      }
      environment[key] = parts.join("");
    }
    services[name] = { ...service, environment };
  }
  return Result.succeed({ ...plan, services });
};

export const verifyPublishedRouteUrls = Effect.fn("Activation.verifyPublishedRouteUrls")(function* (
  proof: PreparedRouteUrls | undefined,
  authorities: readonly ProxyAuthority[],
) {
  if (proof === undefined) return;
  for (const [service, expected] of proof.authorities) {
    if (
      !authorities.some(
        (actual) =>
          actual.port === expected.port &&
          actual.scheme === expected.scheme &&
          actual.hostname.toLowerCase() === expected.hostname.toLowerCase(),
      )
    )
      return yield* new RouteUrlBindingError({
        reason: "authority-changed",
        service,
        message: `The published router authority for ${service} changed during activation.`,
        remediation:
          "The router moved to another port while this command ran. Run the same command again; Lando recreates the services that read the URL.",
      });
  }
});
