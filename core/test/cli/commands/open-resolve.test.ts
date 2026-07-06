import { describe, expect, test } from "bun:test";

import type { AppPlan, RoutePlan } from "@lando/sdk/schema";

import { buildOpenTarget, isOpenableScheme, resolveOpenTargets } from "../../../src/cli/commands/open.ts";

const route = (over: Partial<RoutePlan> & Pick<RoutePlan, "hostname" | "scheme" | "service">): RoutePlan =>
  ({ ...over }) as RoutePlan;

const svc = (name: string) => ({ name, routes: [] }) as unknown;

const plan = (routes: RoutePlan[], serviceNames: string[]): Pick<AppPlan, "services" | "routes"> => {
  const services: Record<string, unknown> = {};
  for (const name of serviceNames) services[name] = svc(name);
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
});

describe("isOpenableScheme", () => {
  test("S6 only http and https are openable", () => {
    expect(isOpenableScheme("https://a.lndo.site")).toBe(true);
    expect(isOpenableScheme("http://a.lndo.site")).toBe(true);
    expect(isOpenableScheme("ftp://a.lndo.site")).toBe(false);
    expect(isOpenableScheme("file:///etc/passwd")).toBe(false);
  });
});
