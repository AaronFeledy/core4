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

import { endpointUrl, formatAuthorityUrl } from "../../../src/cli/authority-url.ts";
import { resolveOpenTargets } from "../../../src/cli/commands/open.ts";

const service = (endpoints: ReadonlyArray<EndpointPlan>): ServicePlan => ({
  name: ServiceName.make("appserver"),
  type: "php:8.4",
  provider: ProviderId.make("test"),
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [...endpoints],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-07-21T00:00:00Z"),
    source: "host-endpoint-urls.test",
    runtime: 4,
  },
  extensions: {},
});

const plan = (
  appserver: ServicePlan,
  routes: ReadonlyArray<RoutePlan> = [],
): Pick<AppPlan, "services" | "routes"> => ({
  services: { [appserver.name]: appserver },
  routes: [...routes],
});

describe("host endpoint URLs", () => {
  test("does not fabricate a localhost URL from an unpublished target port", () => {
    // Given
    const endpoint: EndpointPlan = { protocol: "http", port: 80, name: "http" };

    // When
    const url = endpointUrl(endpoint, "http");

    // Then
    expect(url).toBeUndefined();
  });

  test("lando open --service prefers the service proxy route over its internal endpoint", () => {
    // Given
    const appserver = service([{ protocol: "http", port: 80, name: "http" }]);
    const route: RoutePlan = {
      hostname: "app.test.lndo.site",
      scheme: "https",
      service: appserver.name,
    };

    // When
    const targets = resolveOpenTargets(plan(appserver, [route]), { service: "appserver" });

    // Then
    expect(targets.map((target) => target.url)).toEqual(["https://app.test.lndo.site"]);
  });

  test("a service with only an internal endpoint has no direct host open target", () => {
    // Given
    const appserver = service([{ protocol: "http", port: 80, name: "http" }]);

    // When
    const targets = resolveOpenTargets(plan(appserver), { service: "appserver" });

    // Then
    expect(targets).toEqual([]);
  });

  test.each([
    [{ protocol: "http", port: 8080, publishedPort: 80 } satisfies EndpointPlan, "http://localhost"],
    [{ protocol: "https", port: 8443, bind: "127.0.0.1" } satisfies EndpointPlan, "https://127.0.0.1:8443"],
    [{ protocol: "http", port: 8080, bind: "0.0.0.0" } satisfies EndpointPlan, "http://localhost:8080"],
    [{ protocol: "https", port: 443, bind: "::" } satisfies EndpointPlan, "https://localhost"],
  ])("renders an explicitly published endpoint at its usable host authority", (endpoint, expected) => {
    // When
    const url = endpointUrl(endpoint, endpoint.protocol);

    // Then
    expect(url === undefined ? undefined : formatAuthorityUrl(url)).toBe(expected);
  });
});
