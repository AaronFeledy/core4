import type { AppPlan, RoutePlan } from "@lando/sdk/schema";
import { TestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import { plan, web } from "../operations/start-progress-topology-support.ts";

export const urlReadingPlan: AppPlan = {
  ...plan,
  services: {
    ...plan.services,
    [web.name]: {
      ...web,
      environment: {
        APP_URL: { _tag: "RouteText", parts: [{ service: web.name, encoding: "raw" }] },
      },
    },
  },
  routes: [
    {
      hostname: "earlier.test",
      scheme: "http",
      service: web.name,
      priority: 1,
      backend: { service: web.name, port: 3000, protocol: "http" },
    },
    {
      hostname: "web.test",
      scheme: "both",
      pathPrefix: "/app",
      service: web.name,
      priority: 2,
      backend: { service: web.name, port: 3000, protocol: "http" },
    },
  ],
};

const advertised = (routes: readonly RoutePlan[], tlsPort: number) =>
  routes.flatMap((route) => {
    const schemes = route.scheme === "both" ? (["http", "https"] as const) : [route.scheme];
    return schemes.map((scheme) => ({
      hostname: route.hostname,
      scheme,
      port: scheme === "https" ? tlsPort : 8080,
    }));
  });

export const publicUrlRouter = (publishedTlsPort = 8443): typeof TestRouterService => ({
  ...TestRouterService,
  setup: () => Effect.void,
  routeAuthorities: (routes) => Effect.succeed(advertised(routes, 8443)),
  applyRoutes: (routes, owner) =>
    Effect.succeed({
      app: owner.id,
      appliedRoutes: routes,
      authorities: advertised(routes, publishedTlsPort),
    }),
});
