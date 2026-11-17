import { expect, test } from "bun:test";
import { mergeAppliedPlan } from "@lando/container-runtime/plan";
import { PortablePath, RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";
import { plan, service } from "./fixtures/environment-values.ts";

const route = Schema.decodeUnknownSync(RoutePlan)({
  hostname: "web.lndo.site",
  scheme: "http",
  service: "web",
  backend: { service: "web", protocol: "http", port: 80 },
});

test("remaps carried route refs by canonical equality and appends routes the incoming plan omits", () => {
  const other = { ...route, hostname: RoutePlan.fields.hostname.make("other.lndo.site") };
  const previous = {
    ...plan,
    routes: [route, other],
    services: { web: { ...service, routes: [{ index: 0 }, { index: 1 }] } },
  };
  const incoming = {
    ...plan,
    routes: [
      other,
      {
        backend: route.backend,
        service: route.service,
        scheme: route.scheme,
        hostname: route.hostname,
        priority: route.priority,
      },
    ],
    services: { db: { ...service, name: ServiceName.make("db"), routes: [{ index: 0 }] } },
  };

  expect(mergeAppliedPlan(previous, incoming).services[ServiceName.make("web")]?.routes).toEqual([
    { index: 1 },
    { index: 0 },
  ]);
  // The incoming plan does not name web's own route, so it is carried at the end
  // and the untouched container keeps a valid backend binding.
  const carriedOnly = mergeAppliedPlan(previous, { ...incoming, routes: [other] });
  expect(carriedOnly.services[ServiceName.make("web")]?.routes).toEqual([{ index: 1 }, { index: 0 }]);
  expect(carriedOnly.routes[1]).toEqual(route);
  expect(mergeAppliedPlan(previous, incoming).services[ServiceName.make("db")]).toBe(incoming.services.db);
});

test("carries only mounted previous stores while incoming store definitions win", () => {
  const retained = {
    ...service,
    mounts: ["data", "shared", "external"].map((store) => ({
      type: "volume" as const,
      store,
      target: PortablePath.make(`/${store}`),
      readOnly: false,
    })),
  };
  const previous = {
    ...plan,
    services: { web: retained },
    stores: ["data", "shared", "unused"].map((name) => ({
      name,
      scope: "app" as const,
      kind: "data" as const,
    })),
  };
  const incoming = {
    ...plan,
    services: { db: { ...service, name: ServiceName.make("db") } },
    stores: [{ name: "shared", scope: "global" as const, kind: "cache" as const }],
  };

  const merged = mergeAppliedPlan(previous, incoming);

  expect(merged.stores).toEqual([
    { name: "shared", scope: "global", kind: "cache" },
    { name: "data", scope: "app", kind: "data" },
  ]);
  expect(mergeAppliedPlan(previous, incoming, { complete: true })).toBe(incoming);
  expect(mergeAppliedPlan(previous, incoming, { complete: false })).toEqual(merged);
});

test("keeps an untouched container's historical both route beside new per-scheme routes", () => {
  // Given: an applied record from before per-scheme plans, one route per service.
  const bothRoute = Schema.decodeUnknownSync(RoutePlan)({
    hostname: "db.lndo.site",
    scheme: "both",
    service: "db",
    backend: { service: "db", protocol: "http", port: 80 },
  });
  const previous = {
    ...plan,
    routes: [bothRoute],
    services: {
      web: { ...service, routes: [] },
      db: { ...service, name: ServiceName.make("db"), routes: [{ index: 0 }] },
    },
  };
  // When: a selected activation records fresh per-scheme routes for web only.
  const httpRoute = Schema.decodeUnknownSync(RoutePlan)({
    hostname: "web.lndo.site",
    scheme: "http",
    service: "web",
    backend: { service: "web", protocol: "http", port: 80 },
  });
  const httpsRoute = Schema.decodeUnknownSync(RoutePlan)({
    hostname: "web.lndo.site",
    scheme: "https",
    service: "web",
    backend: { service: "web", protocol: "https", port: 443 },
  });
  const incoming = {
    ...plan,
    routes: [httpRoute, httpsRoute],
    services: { web: { ...service, routes: [{ index: 0 }, { index: 1 }] } },
  };
  // Then: the untouched service keeps both its route object and its reference.
  const merged = mergeAppliedPlan(previous, incoming);
  expect(merged.services[ServiceName.make("db")]?.routes).toEqual([{ index: 2 }]);
  expect(merged.routes[2]).toEqual(bothRoute);
  expect(merged.services[ServiceName.make("web")]?.routes).toEqual([{ index: 0 }, { index: 1 }]);
});
