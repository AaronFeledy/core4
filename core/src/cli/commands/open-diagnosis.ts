import { routerEnabled } from "@lando/engine/config/router-config";
import { effectiveRoutePath } from "@lando/engine/operations/connection-url";
import { OpenTargetUnresolvedError } from "@lando/sdk/errors";
import { type AppPlan, type RoutePlan, type StartedService, isWildcardHostname } from "@lando/sdk/schema";
import { type OpenTarget, type OpenTargetSelection, resolveOpenTargets } from "./open-targets";

const knownServices = (plan: AppPlan) => Object.values(plan.services).map(({ name }) => String(name));
const knownServicesText = (services: readonly string[]) =>
  `Known services: ${services.join(", ") || "none"}.`;
const ENABLE_ROUTER = "Set `router:` `enabled: true` in your Landofile to publish the declared routes";
const CHOOSE_LISTENER =
  "For multiple HTTP listeners, pass the route hostname to `lando open` or mark the intended HTTP endpoint primary: true, then rerun `lando open`.";

export const diagnoseUnresolvedOpenTarget = (
  plan: AppPlan,
  options: OpenTargetSelection,
  connections: readonly StartedService[],
): OpenTargetUnresolvedError => {
  const services = knownServices(plan);
  const known = knownServicesText(services);
  const routingEnabled = routerEnabled(plan);
  const unpublishedRoutes = !routingEnabled && plan.routes.length > 0;
  const selectedService = options.service;
  if (routingEnabled) {
    const hosts = plan.routes
      .filter((route) => selectedService === undefined || route.service === selectedService)
      .map((route) => route.hostname);
    if (hosts.length > 0 && hosts.every(isWildcardHostname)) {
      const selection = selectedService === undefined ? "the app" : `service ${selectedService}`;
      const patterns = [...new Set(hosts)].join(", ");
      return new OpenTargetUnresolvedError({
        message: `No openable URL for ${plan.name}: ${selection} declares only hostname-pattern routes (${patterns}), and a pattern names no single URL. ${known}`,
        remediation:
          "Run `lando open <hostname>` with a hostname the pattern matches, add a route with a concrete hostname, or publish an HTTP port.",
        app: plan.name,
        services,
      });
    }
  }
  if (selectedService !== undefined && resolveOpenTargets(plan, { all: true }, connections).length > 0) {
    return new OpenTargetUnresolvedError({
      message: `No openable URL matched --service ${selectedService} for ${plan.name}. ${known}`,
      remediation: `Choose one of the listed services or routes. ${CHOOSE_LISTENER}`,
      app: plan.name,
      services,
    });
  }
  return new OpenTargetUnresolvedError({
    message: unpublishedRoutes
      ? `No openable URL for ${plan.name}: its routes are declared but the router is disabled, and no service publishes an http host port. ${known}`
      : `No active host HTTP(S) connection for ${plan.name}. ${known}`,
    app: plan.name,
    services,
    remediation: unpublishedRoutes
      ? `${ENABLE_ROUTER}, or publish an http endpoint on a host port, then rerun \`lando open\`.`
      : `Start the app and ensure its proxy routes or HTTP host publications are active. ${CHOOSE_LISTENER}`,
  });
};

type HostnameResolutionFailure =
  | { readonly kind: "disabled" }
  | { readonly kind: "unmatched" }
  | { readonly kind: "unpublished"; readonly routes: readonly RoutePlan[] }
  | { readonly kind: "inactive"; readonly route: RoutePlan }
  | { readonly kind: "ambiguous"; readonly url: string; readonly routes: ReadonlyMap<string, string> };

const routeHostnames = (routes: readonly RoutePlan[]): string =>
  [...new Set(routes.map(({ hostname }) => hostname))].join(", ") || "none";

export const diagnoseUnresolvedHostname = (
  plan: AppPlan,
  hostname: string,
  failure: HostnameResolutionFailure,
): OpenTargetUnresolvedError => {
  const services = knownServices(plan);
  const known = knownServicesText(services);
  const error = (message: string, remediation: string) =>
    new OpenTargetUnresolvedError({ app: plan.name, services, message, remediation });
  switch (failure.kind) {
    case "disabled":
      return error(
        `No openable URL for ${hostname} in ${plan.name}: a declared route matches it but the router is disabled. ${known}`,
        `${ENABLE_ROUTER}.`,
      );
    case "unmatched": {
      const serviceHint = services.includes(hostname)
        ? ` To open that service, run \`lando open --service ${hostname}\`.`
        : "";
      return error(
        `No route of ${plan.name} matches ${hostname}. Declared route hostnames: ${routeHostnames(plan.routes)}. ${known}`,
        `Pass a hostname one of those routes matches, or add a route for it and run \`lando start\`.${serviceHint}`,
      );
    }
    case "unpublished":
      return error(
        `Route ${routeHostnames(failure.routes)} of ${plan.name} matches ${hostname} but the router is not serving it. ${known}`,
        "Run `lando start`, then check the route with `lando info`.",
      );
    case "inactive":
      return error(
        `Route ${failure.route.hostname} matches ${hostname}, but service ${failure.route.service} is not running. ${known}`,
        `Run \`lando start\`, then rerun \`lando open ${hostname}\`.`,
      );
    case "ambiguous": {
      const names = [...failure.routes.keys()];
      const owners = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
      return error(
        `${failure.url} is matched equally by routes of services ${owners} (${[...failure.routes.values()].join(", ")}). Lando cannot guarantee which service answers. ${known}`,
        "Give one route a more specific hostname or a longer path prefix.",
      );
    }
    default:
      return failure satisfies never;
  }
};

export const diagnoseBrowserRoute = (
  plan: AppPlan,
  { hostname, url }: OpenTarget,
  pathPrefix: string,
): OpenTargetUnresolvedError | undefined => {
  const parsed = URL.parse(url);
  const fields = { app: plan.name, services: knownServices(plan) };
  if (parsed?.hostname !== hostname) {
    return new OpenTargetUnresolvedError({
      ...fields,
      message: `Browsers cannot open ${hostname} as written: they reject it or read it as a different address.`,
      remediation: "Choose a canonical hostname, for example one whose last label is not a number.",
    });
  }
  if (parsed.pathname !== effectiveRoutePath(pathPrefix)) {
    return new OpenTargetUnresolvedError({
      ...fields,
      message: `Browsers normalize the route prefix ${pathPrefix} for ${hostname} to ${parsed.pathname}.`,
      remediation: "Configure the route with a canonical path prefix that browsers do not rewrite.",
    });
  }
};
