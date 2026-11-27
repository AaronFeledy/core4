import { expect, test } from "bun:test";
import { type RoutePlan, RoutePlan as RoutePlanSchema, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";
import { routeAddress, routeFacts } from "../../src/operations/connection-url.ts";

const route = (hostname: string, pathPrefix?: string): RoutePlan => {
  const service = ServiceName.make("web");
  // Decode so the hostname is one the route schema admits.
  return Schema.decodeUnknownSync(RoutePlanSchema)({
    hostname,
    priority: 2,
    scheme: "https",
    service,
    backend: { service, protocol: "http", port: 8080 },
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
  });
};

test.each([
  ["web.example.test", "https", 443, "/", "web.example.test", "https://web.example.test/"],
  ["web.example.test", "https", 8443, "/api/", "web.example.test", "https://web.example.test:8443/api/"],
  ["*.EXAMPLE.test", "http", 38080, "/api", "*.example.test", undefined],
  ["Web.EXAMPLE.test", "https", 443, undefined, "web.example.test", "https://web.example.test"],
  ["127.0.0.1", "http", 80, undefined, "127.0.0.1", "http://127.0.0.1"],
] as const)(
  "projects the route address for %s on %s/%s with prefix %s",
  (hostname, protocol, port, pathPrefix, host, url) => {
    const address = routeAddress(route(hostname, pathPrefix), protocol, port);
    const expected = { host, protocol, port, pathPrefix: pathPrefix ?? "" };
    expect(address).toEqual(
      url === undefined ? { ...expected, hostMatch: "pattern" } : { ...expected, hostMatch: "exact", url },
    );
    expect("url" in address).toBe(url !== undefined);
  },
);

test.each([
  {
    name: "default https port, path prefix",
    route: route("web.example.test", "/app"),
    protocol: "https",
    port: 443,
    facts: {
      url: "https://web.example.test/app",
      hostname: "web.example.test",
      origin: "https://web.example.test",
      publicPort: "443",
      scheme: "https",
    },
  },
  {
    name: "default http port",
    route: route("web.example.test"),
    protocol: "http",
    port: 80,
    facts: {
      url: "http://web.example.test",
      hostname: "web.example.test",
      origin: "http://web.example.test",
      publicPort: "80",
      scheme: "http",
    },
  },
  {
    name: "http on a moved port",
    route: route("web.example.test", "/"),
    protocol: "http",
    port: 8080,
    facts: {
      url: "http://web.example.test:8080/",
      hostname: "web.example.test",
      origin: "http://web.example.test:8080",
      publicPort: "8080",
      scheme: "http",
    },
  },
  {
    name: "https on port 80 keeps its port",
    route: route("web.example.test"),
    protocol: "https",
    port: 80,
    facts: {
      url: "https://web.example.test:80",
      hostname: "web.example.test",
      origin: "https://web.example.test:80",
      publicPort: "80",
      scheme: "https",
    },
  },
  {
    name: "http on the degraded router port",
    route: route("web.example.test"),
    protocol: "http",
    port: 38080,
    facts: {
      url: "http://web.example.test:38080",
      hostname: "web.example.test",
      origin: "http://web.example.test:38080",
      publicPort: "38080",
      scheme: "http",
    },
  },
  {
    name: "https on the degraded router port",
    route: route("web.example.test"),
    protocol: "https",
    port: 38443,
    facts: {
      url: "https://web.example.test:38443",
      hostname: "web.example.test",
      origin: "https://web.example.test:38443",
      publicPort: "38443",
      scheme: "https",
    },
  },
  {
    name: "uppercase route hostname",
    route: route("Web.Example.TEST"),
    protocol: "https",
    port: 8443,
    facts: {
      url: "https://web.example.test:8443",
      hostname: "web.example.test",
      origin: "https://web.example.test:8443",
      publicPort: "8443",
      scheme: "https",
    },
  },
  {
    name: "punycode hostname stays ASCII",
    route: route("xn--bcher-kva.example"),
    protocol: "https",
    port: 443,
    facts: {
      url: "https://xn--bcher-kva.example",
      hostname: "xn--bcher-kva.example",
      origin: "https://xn--bcher-kva.example",
      publicPort: "443",
      scheme: "https",
    },
  },
  {
    name: "IP-like 127.1 is not rewritten",
    route: route("127.1"),
    protocol: "http",
    port: 8080,
    facts: {
      url: "http://127.1:8080",
      hostname: "127.1",
      origin: "http://127.1:8080",
      publicPort: "8080",
      scheme: "http",
    },
  },
  {
    name: "numeric last label web.123 is not rejected",
    route: route("web.123", "/x"),
    protocol: "https",
    port: 443,
    facts: {
      url: "https://web.123/x",
      hostname: "web.123",
      origin: "https://web.123",
      publicPort: "443",
      scheme: "https",
    },
  },
] as const)("projects route facts: $name", ({ route, protocol, port, facts }) => {
  const address = routeAddress(route, protocol, port);
  expect(address.hostMatch === "exact" && routeFacts(address)).toEqual(facts);
});
