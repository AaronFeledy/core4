import { routerEnabled } from "@lando/engine/config/router-config";
import {
  collectPlanObservations,
  observePlanRoutes,
  projectObservedServices,
} from "@lando/engine/operations/connection-collector";
import { hostnameCandidates, publishedRouteRules } from "@lando/engine/operations/hostname-route";
import { type AppPlan, hostnameMatchesRoute, isWildcardHostname } from "@lando/sdk/schema";
import { Effect } from "effect";
import { diagnoseBrowserRoute, diagnoseUnresolvedHostname } from "./open-diagnosis";
import type { OpenTarget } from "./open-targets";

export const resolveHostnameTarget = Effect.fn("OpenApp.resolveHostname")(function* (
  plan: AppPlan,
  hostname: string,
) {
  const matching = plan.routes.filter((route) => hostnameMatchesRoute(hostname, route.hostname));
  if (matching.length === 0)
    return yield* Effect.fail(diagnoseUnresolvedHostname(plan, hostname, { kind: "unmatched" }));
  if (!routerEnabled(plan))
    return yield* Effect.fail(diagnoseUnresolvedHostname(plan, hostname, { kind: "disabled" }));

  const evidence = yield* observePlanRoutes({ ...plan, routes: matching });
  const candidates = hostnameCandidates(hostname, publishedRouteRules(plan.routes, evidence));
  // A published, unshadowed exact route owns this hostname even when its service is down.
  const exact = candidates.filter(({ rule }) => !isWildcardHostname(rule.route.hostname));
  const considered = exact.length > 0 ? exact : candidates;
  const first = considered[0];
  if (first === undefined) {
    return yield* Effect.fail(
      diagnoseUnresolvedHostname(plan, hostname, { kind: "unpublished", routes: matching }),
    );
  }

  const services = new Set(considered.map(({ rule }) => rule.route.service));
  const narrowPlan = {
    ...plan,
    services: Object.fromEntries(
      Object.entries(plan.services).filter(([, service]) => services.has(service.name)),
    ),
    routes: matching,
  };
  const observations = yield* collectPlanObservations(narrowPlan, plan);
  const rows = projectObservedServices(narrowPlan, observations, evidence);
  const chosen = considered.find(({ rule }) =>
    rows.some(
      (service) =>
        service.name === rule.route.service &&
        service.routes.some(
          (row) =>
            row.binding === "assigned" &&
            row.state === "active" &&
            row.host === rule.route.hostname.toLowerCase() &&
            row.protocol === rule.protocol &&
            row.port === rule.port &&
            row.pathPrefix === (rule.route.pathPrefix ?? ""),
        ),
    ),
  );
  if (chosen === undefined) {
    return yield* Effect.fail(
      diagnoseUnresolvedHostname(plan, hostname, { kind: "inactive", route: first.rule.route }),
    );
  }
  const topServices = new Map(chosen.top.map(({ route }) => [route.service, route.hostname]));
  if (topServices.size > 1) {
    return yield* Effect.fail(
      diagnoseUnresolvedHostname(plan, hostname, { kind: "ambiguous", url: chosen.url, routes: topServices }),
    );
  }
  const target = {
    service: chosen.rule.route.service,
    hostname,
    scheme: chosen.rule.protocol,
    url: chosen.url,
  } satisfies OpenTarget;
  const browserError = diagnoseBrowserRoute(plan, target, chosen.rule.route.pathPrefix ?? "");
  if (browserError !== undefined) return yield* Effect.fail(browserError);
  return target;
});
