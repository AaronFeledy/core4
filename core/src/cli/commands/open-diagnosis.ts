import { routerEnabled } from "@lando/engine/config/router-config";
import { OpenTargetUnresolvedError } from "@lando/sdk/errors";
import { type AppPlan, type StartedService, isWildcardHostname } from "@lando/sdk/schema";
import { type OpenTargetSelection, resolveOpenTargets } from "./open-targets";

export const diagnoseUnresolvedOpenTarget = (
  plan: AppPlan,
  options: OpenTargetSelection,
  connections: readonly StartedService[],
): OpenTargetUnresolvedError => {
  const knownServices = Object.values(plan.services).map((service) => String(service.name));
  const knownServicesText = knownServices.length === 0 ? "none" : knownServices.join(", ");
  const routingEnabled = routerEnabled(plan);
  const unpublishedRoutes = !routingEnabled && plan.routes.length > 0;
  const namedRoute = options.route;
  if (namedRoute !== undefined && plan.routes.some((route) => route.hostname === namedRoute)) {
    if (unpublishedRoutes) {
      return new OpenTargetUnresolvedError({
        message: `No openable URL matched --route ${namedRoute} for ${plan.name}: that hostname is declared but the router is disabled. Known services: ${knownServicesText}.`,
        remediation:
          "Set `router:` `enabled: true` in your Landofile to publish the declared routes, or omit `--route` to open a published http host port.",
      });
    }
    if (isWildcardHostname(namedRoute)) {
      return new OpenTargetUnresolvedError({
        message: `No openable URL matched --route ${namedRoute} for ${plan.name}: it is a hostname pattern, and a pattern names no single URL. Known services: ${knownServicesText}.`,
        remediation:
          "Pass --route with a concrete hostname this app declares, or open a hostname the pattern matches yourself.",
        app: plan.name,
        services: knownServices,
      });
    }
  }
  if (namedRoute === undefined && routingEnabled) {
    const selectedService = options.service;
    const hosts = plan.routes
      .filter((route) => selectedService === undefined || route.service === selectedService)
      .map((route) => route.hostname);
    if (hosts.length > 0 && hosts.every(isWildcardHostname)) {
      const selection = selectedService === undefined ? "the app" : `service ${selectedService}`;
      const patterns = [...new Set(hosts)].join(", ");
      return new OpenTargetUnresolvedError({
        message: `No openable URL for ${plan.name}: ${selection} declares only hostname-pattern routes (${patterns}), and a pattern names no single URL. Known services: ${knownServicesText}.`,
        remediation:
          "Add a route with a concrete hostname or publish an HTTP port, then run `lando start`; or open a hostname the pattern matches yourself.",
        app: plan.name,
        services: knownServices,
      });
    }
  }
  if (
    (options.service !== undefined || options.route !== undefined) &&
    resolveOpenTargets(plan, { all: true }, connections).length > 0
  ) {
    const selected =
      options.route !== undefined ? `--route ${options.route}` : `--service ${options.service ?? ""}`;
    return new OpenTargetUnresolvedError({
      message: `No openable URL matched ${selected} for ${plan.name}. Known services: ${knownServicesText}.`,
      remediation:
        "Choose one of the listed services or routes. For multiple HTTP listeners, select an explicit --route or mark the intended HTTP endpoint primary: true, then rerun `lando open`.",
    });
  }
  return new OpenTargetUnresolvedError({
    message: unpublishedRoutes
      ? `No openable URL for ${plan.name}: its routes are declared but the router is disabled, and no service publishes an http host port. Known services: ${knownServicesText}.`
      : `No active host HTTP(S) connection for ${plan.name}. Known services: ${knownServicesText}.`,
    app: plan.name,
    services: knownServices,
    remediation: unpublishedRoutes
      ? "Set `router:` `enabled: true` in your Landofile to publish the declared routes, or publish an http endpoint on a host port, then rerun `lando open`."
      : "Start the app and ensure its proxy routes or HTTP host publications are active. For multiple HTTP listeners, select an explicit --route or mark the intended HTTP endpoint primary: true, then rerun `lando open`.",
  });
};
