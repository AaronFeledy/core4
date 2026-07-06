import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import {
  type AppPlan,
  type EndpointPlan,
  ProviderId,
  type RoutePlan,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { buildOpenTarget, isOpenableScheme, resolveOpenTargets } from "../../../src/cli/commands/open.ts";

const route = (
  over: Partial<Omit<RoutePlan, "service">> &
    Pick<RoutePlan, "hostname" | "scheme"> & { readonly service: string },
): RoutePlan => ({ ...over, service: ServiceName.make(over.service) });

const endpoint = (over: EndpointPlan): EndpointPlan => over;

const svc = (name: string, endpoints: ReadonlyArray<EndpointPlan> = []): ServicePlan => ({
  name: ServiceName.make(name),
  type: "generic",
  provider: ProviderId.make("test"),
  primary: false,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [...endpoints],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-07-06T00:00:00Z"),
    source: "open-resolve.test",
    runtime: 4,
  },
  extensions: {},
});

const plan = (
  routes: RoutePlan[],
  serviceNames: ReadonlyArray<string | ServicePlan>,
): Pick<AppPlan, "services" | "routes"> => {
  const services: Record<string, ServicePlan> = {};
  for (const service of serviceNames) {
    const resolved = typeof service === "string" ? svc(service) : service;
    services[resolved.name] = resolved;
  }
  return { services, routes } as Pick<AppPlan, "services" | "routes">;
};

describe("buildOpenTarget", () => {
  test("collapses scheme both to https and builds the url", () => {
    const target = buildOpenTarget(
      route({ hostname: "web.myapp.lndo.site", scheme: "both", service: "web" }),
    );
    expect(target).toEqual({
      service: "web",
      hostname: "web.myapp.lndo.site",
      scheme: "https",
      url: "https://web.myapp.lndo.site",
    });
  });

  test("preserves http scheme and appends pathPrefix", () => {
    const target = buildOpenTarget(
      route({ hostname: "api.myapp.lndo.site", scheme: "http", service: "api", pathPrefix: "/v1" }),
    );
    expect(target.scheme).toBe("http");
    expect(target.url).toBe("http://api.myapp.lndo.site/v1");
  });
});

describe("resolveOpenTargets", () => {
  const routes = [
    route({ hostname: "api.myapp.lndo.site", scheme: "http", service: "api" }),
    route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" }),
    route({ hostname: "web-alt.myapp.lndo.site", scheme: "http", service: "web" }),
  ];
  const p = plan(routes, ["api", "web"]);

  test("S1 default resolves first route of first declaring service", () => {
    const result = resolveOpenTargets(p, {});
    expect(result.map((r) => r.hostname)).toEqual(["api.myapp.lndo.site"]);
  });

  test("S1 default prefers https within the chosen service", () => {
    const httpsFirst = plan(
      [
        route({ hostname: "web-http.lndo.site", scheme: "http", service: "web" }),
        route({ hostname: "web-https.lndo.site", scheme: "https", service: "web" }),
      ],
      ["web"],
    );
    expect(resolveOpenTargets(httpsFirst, {}).map((r) => r.hostname)).toEqual(["web-https.lndo.site"]);
  });

  test("S2 --service scopes to that service (prefer https)", () => {
    expect(resolveOpenTargets(p, { service: "web" }).map((r) => r.hostname)).toEqual(["web.myapp.lndo.site"]);
  });

  test("S3 --route selects an exact hostname", () => {
    expect(resolveOpenTargets(p, { route: "web-alt.myapp.lndo.site" }).map((r) => r.hostname)).toEqual([
      "web-alt.myapp.lndo.site",
    ]);
  });

  test("S4 --all resolves every route in plan order", () => {
    expect(resolveOpenTargets(p, { all: true }).map((r) => r.hostname)).toEqual([
      "api.myapp.lndo.site",
      "web.myapp.lndo.site",
      "web-alt.myapp.lndo.site",
    ]);
  });

  test("S5 no routes resolves to an empty list", () => {
    expect(resolveOpenTargets(plan([], ["web"]), {})).toEqual([]);
    expect(resolveOpenTargets(p, { service: "missing" })).toEqual([]);
    expect(resolveOpenTargets(p, { route: "nope.lndo.site" })).toEqual([]);
  });

  test("S5 falls back to http endpoints when no matching route exists", () => {
    const p = plan(
      [],
      [
        svc("web", [
          endpoint({ protocol: "tcp", port: 3306 }),
          endpoint({ protocol: "http", port: 8080 }),
          endpoint({ protocol: "https", port: 8443 }),
        ]),
      ],
    );
    expect(resolveOpenTargets(p, {}).map((r) => r.url)).toEqual(["https://localhost:8443"]);
    expect(resolveOpenTargets(p, { service: "web" }).map((r) => r.url)).toEqual(["https://localhost:8443"]);
    expect(resolveOpenTargets(p, { all: true }).map((r) => r.url)).toEqual([
      "http://localhost:8080",
      "https://localhost:8443",
    ]);
  });
});

describe("isOpenableScheme", () => {
  test("S6 only http and https are openable", () => {
    expect(isOpenableScheme("https://a.lndo.site")).toBe(true);
    expect(isOpenableScheme("http://a.lndo.site")).toBe(true);
    expect(isOpenableScheme("ftp://a.lndo.site")).toBe(false);
    expect(isOpenableScheme("file:///etc/passwd")).toBe(false);
  });
});
