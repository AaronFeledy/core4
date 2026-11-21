import { expect, test } from "bun:test";
import { type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { routeUrl } from "../../src/operations/connection-url.ts";

test.each(["/api/", "/"])("preserves the authored route prefix %s in the public URL", (pathPrefix) => {
  const service = ServiceName.make("web");
  const route: RoutePlan = {
    hostname: "web.example.test",
    priority: 2,
    scheme: "https",
    service,
    backend: { service, protocol: "http", port: 8080 },
    pathPrefix,
  };
  expect(routeUrl(route, "https", 443)).toBe(`https://web.example.test${pathPrefix}`);
});
