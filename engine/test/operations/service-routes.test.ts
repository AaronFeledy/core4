import { expect, test } from "bun:test";
import type { ProxyAuthority, RoutePlan } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import { collectObservedConnections, observeService } from "../../src/operations/connection-collector.ts";
import { projectServiceRoutes } from "../../src/operations/service-routes.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const route = {
  hostname: "web.example.test",
  scheme: "both",
  priority: 2,
  service: web.name,
  backend: { service: web.name, protocol: "http", port: 3000, host: "web.internal" },
} as const satisfies RoutePlan;
const http = { hostname: route.hostname, scheme: "http", port: 80 } as const satisfies ProxyAuthority;
const https = { hostname: route.hostname, scheme: "https", port: 443 } as const satisfies ProxyAuthority;

test("reports concrete and wildcard routes separately from listener and publication addresses", async () => {
  const pattern = { ...route, scheme: "https", hostname: "*.example.test" } as const;
  const planned = { ...plan, routes: [route, pattern] };
  const observed = observeService(planned, {
    app: plan.id,
    service: web.name,
    providerId: plan.provider,
    status: "running",
    publications: {
      status: "present",
      bindings: [{ port: 3000, transport: "tcp", hostPort: 3000, bindAddress: "127.0.0.1" }],
    },
  });
  const [row] = await Effect.runPromise(
    collectObservedConnections(planned, [observed]).pipe(
      Effect.provideService(RouterService, {
        ...makeTestRouterService(),
        observeRoutes: () =>
          Effect.succeed({
            configuredAuthorities: [http, https],
            observation: {
              status: "present",
              publications: [
                { route, authority: http },
                { route, authority: https },
                { route: pattern, authority: { ...https, hostname: pattern.hostname } },
              ],
            },
          }),
      }),
    ),
  );
  expect(row?.connections.map(({ source }) => source)).toEqual(["listener", "publication"]);
  expect(row?.routes).toMatchObject([
    { hostMatch: "exact", url: "http://web.example.test" },
    { hostMatch: "exact", url: "https://web.example.test" },
    { hostMatch: "pattern", binding: "assigned", state: "active", port: 443 },
  ]);
  expect(row?.routes.map((report) => "url" in report)).toEqual([true, true, false]);
});

test("projects one pending row for each scheme without a router port", () => {
  const rows = projectServiceRoutes({ service: web, state: "running", routes: [route] });
  expect(rows.map(({ protocol, binding, state }) => ({ protocol, binding, state }))).toEqual([
    { protocol: "http", binding: "pending", state: "unknown" },
    { protocol: "https", binding: "pending", state: "unknown" },
  ]);
});

test("keeps configured and observed ports distinct for one scheme", () => {
  const secure = { ...route, scheme: "https" } as const;
  const rows = projectServiceRoutes({
    service: web,
    state: "running",
    routes: [secure],
    routeEvidence: {
      configuredAuthorities: [https],
      observation: {
        status: "present",
        publications: [{ route: secure, authority: { ...https, port: 8443 } }],
      },
    },
  });
  expect(rows).toMatchObject([
    { binding: "assigned", state: "inactive", port: 443, url: "https://web.example.test" },
    { binding: "assigned", state: "active", port: 8443, url: "https://web.example.test:8443" },
  ]);
});

test.each(["host", "path", "scheme"] as const)("rejects live evidence with mismatched route %s", (part) => {
  const other = {
    ...route,
    ...(part === "host" ? { backend: { ...route.backend, host: "foreign.internal" } } : {}),
    ...(part === "path" ? { pathPrefix: "/other" } : {}),
    ...(part === "scheme" ? { scheme: "https" as const } : {}),
  };
  const rows = projectServiceRoutes({
    service: web,
    state: "running",
    routes: [route],
    routeEvidence: {
      configuredAuthorities: [http, https],
      observation: {
        status: "present",
        publications: [http, https].map((authority) => ({ route: other, authority })),
      },
    },
  });
  expect(rows.map(({ state }) => state)).toEqual(["inactive", "inactive"]);
});
