import { expect, test } from "bun:test";
import { type RoutePlan, RoutePlan as RoutePlanSchema, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";
import { routeFacts, routeUrl } from "../../src/operations/connection-url.ts";

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

test.each(["/api/", "/"])("preserves the authored route prefix %s in the public URL", (pathPrefix) => {
  expect(routeUrl(route("web.example.test", pathPrefix), "https", 443)).toBe(
    `https://web.example.test${pathPrefix}`,
  );
});

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
    },
  },
  {
    name: "IP-like 127.1 is not rewritten",
    route: route("127.1"),
    protocol: "http",
    port: 8080,
    facts: { url: "http://127.1:8080", hostname: "127.1", origin: "http://127.1:8080" },
  },
  {
    name: "numeric last label web.123 is not rejected",
    route: route("web.123", "/x"),
    protocol: "https",
    port: 443,
    facts: { url: "https://web.123/x", hostname: "web.123", origin: "https://web.123" },
  },
] as const)("projects route facts: $name", ({ route, protocol, port, facts }) => {
  expect(routeFacts(route, protocol, port)).toEqual(facts);
});
