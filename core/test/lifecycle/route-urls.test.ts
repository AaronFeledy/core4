import { expect, test } from "bun:test";

import { type ProxyAuthority, type RoutePlan, ServiceName } from "@lando/sdk/schema";

import { proxyUrlsByService } from "../../src/lifecycle/route-urls.ts";

test("brackets IPv6 authorities in route URLs", () => {
  const service = ServiceName.make("web");
  const routes: ReadonlyArray<RoutePlan> = [
    {
      hostname: "2001:db8::1",
      scheme: "https",
      service,
      backend: { service, protocol: "http", port: 8080 },
    },
  ];
  const authorities: ReadonlyArray<ProxyAuthority> = [
    { scheme: "https", hostname: "2001:db8::1", port: 4443 },
  ];

  expect(proxyUrlsByService(routes, authorities).get(service)).toEqual(["https://[2001:db8::1]:4443"]);
});
