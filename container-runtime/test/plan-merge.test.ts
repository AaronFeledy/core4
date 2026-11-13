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

test("remaps carried route refs by canonical equality and drops absent routes", () => {
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
  expect(
    mergeAppliedPlan(previous, { ...incoming, routes: [other] }).services[ServiceName.make("web")]?.routes,
  ).toEqual([{ index: 0 }]);
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
