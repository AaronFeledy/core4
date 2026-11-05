import { expect, test } from "bun:test";
import { parseRouteHostname, parseRoutePathPrefix, parseRouteShorthand } from "@lando/sdk/landofile";
import {
  CertificateName,
  DomainName,
  HostAliasName,
  RouteHostname,
  RoutePathPrefix,
  RoutePlan,
  ServiceName,
  certificateNameForHostname,
  getJsonSchema,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const longestHostname = [63, 63, 63, 61].map((length) => "a".repeat(length)).join(".");

const routeFixture = (hostname: string, scheme: "http" | "https" | "both" = "https") =>
  ({
    hostname,
    scheme,
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http", port: 80 },
  }) as const;

test.each([
  "localhost",
  "lndo.site",
  "APP-1.lando.test",
  "a".repeat(63),
  longestHostname,
  "*.site",
  "*-app.site",
  "api*.app.lndo.site",
])("accepts and round-trips concrete host pattern %s", (hostname) => {
  // Given
  const route = routeFixture(hostname, "https");
  // When
  const decoded = Schema.decodeUnknownSync(RoutePlan)(route);
  // Then
  expect(Schema.encodeSync(RoutePlan)(decoded).hostname).toBe(hostname);
  expect(parseRouteHostname(hostname)).toEqual(Result.succeed(hostname));
  expect(parseRouteShorthand(`${hostname}:8080/api`)).toEqual(
    Result.succeed({ hostname, endpoint: 8080, pathPrefix: "/api" }),
  );
});

test.each(["wild.*.site", "a**b.*x*.site"])(
  "decodes deep-wildcard host pattern %s on every RoutePlan scheme so applied plans stay readable",
  (hostname) => {
    for (const scheme of ["http", "https", "both"] as const)
      expect(Schema.decodeUnknownSync(RoutePlan)(routeFixture(hostname, scheme)).hostname).toBe(hostname);
    expect(parseRouteHostname(hostname)).toEqual(Result.succeed(hostname));
  },
);

test.each([
  "",
  "a..site",
  "-a.site",
  "a-.site",
  "app.site\n",
  "a_b.site",
  "app.site:8080",
  "a".repeat(64),
  `${longestHostname}a`,
])("rejects invalid host patterns at every concrete boundary: %j", (hostname) => {
  // Given / When
  const decoded = Schema.decodeUnknownResult(RouteHostname)(hostname);
  // Then
  expect(Result.isFailure(decoded)).toBe(true);
  expect(Result.isFailure(parseRouteHostname(hostname))).toBe(true);
});

test.each(["a".repeat(64), `${longestHostname}a`])("rejects overlong shorthand hostnames: %s", (hostname) => {
  // Given / When
  const result = parseRouteShorthand(`${hostname}/api`);
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toMatch(/63|253/);
});

test.each(["lndo.site", "localhost", "lando.test", longestHostname])("accepts plain domain %s", (domain) => {
  // Given / When
  const decoded = Schema.decodeUnknownSync(DomainName)(domain);
  // Then
  expect(decoded).toBe(domain);
});

test.each([
  "*.site",
  "a*b.site",
  "https://site",
  "site:80",
  "site/path",
  "site\n",
  "a".repeat(64),
  `${longestHostname}a`,
])("rejects non-domain %j", (domain) => {
  // Given / When
  const decoded = Schema.decodeUnknownResult(DomainName)(domain);
  // Then
  expect(Result.isFailure(decoded)).toBe(true);
});

test.each(["host.lando.internal", "my_db", "API.example.test", "_db", "db_", "_"])(
  "accepts HostAliasName %s",
  (name) => {
    // Given / When
    const decoded = Schema.decodeUnknownSync(HostAliasName)(name);
    // Then
    expect(decoded).toBe(name);
  },
);

test.each(["bad host", "*.x.test", "x.test:80", "x.test.", "-x.test"])("rejects HostAliasName %j", (name) => {
  // Given / When
  const decoded = Schema.decodeUnknownResult(HostAliasName)(name);
  // Then
  expect(Result.isFailure(decoded)).toBe(true);
});

test.each([
  "web",
  "my_db.app.internal",
  "*.app.lndo.site",
  "127.0.0.1",
  "::1",
  "xn--bcher-kva.example",
  "_db.app.internal",
])("accepts CertificateName %s", (name) => {
  // Given / When
  const decoded = Schema.decodeUnknownSync(CertificateName)(name);
  // Then
  expect(decoded).toBe(name);
});

test.each([
  "*-app.lndo.site",
  "wild.*.lndo.site",
  "[::1]",
  "a.b.",
  "bücher.example",
  "fe80::1%eth0",
  "::1\n",
  `*.${longestHostname}`,
])("rejects CertificateName %j", (name) => {
  // Given / When
  const decoded = Schema.decodeUnknownResult(CertificateName)(name);
  // Then
  expect(Result.isFailure(decoded)).toBe(true);
});

test.each([
  ["app.lndo.site", "app.lndo.site"],
  ["*.app.lndo.site", "*.app.lndo.site"],
  ["*-app.lndo.site", "*.lndo.site"],
  ["api*.app.lndo.site", "*.app.lndo.site"],
  ["wild.*.app.lndo.site", undefined],
  ["*.*.lndo.site", undefined],
  ["bad !*.app.lndo.site", undefined],
] as const)("certificateNameForHostname(%s) -> %s", (hostname, expected) => {
  // Given / When / Then
  expect(certificateNameForHostname(hostname)).toBe(expected);
});

test.each(["/", "/api", "/a:b", "/a%20b", "", "api", "/a b", "/api\n", "/a?b", "/a#b"])(
  "shares path-prefix validation: %j",
  (pathPrefix) => {
    // Given / When
    const decoded = Schema.decodeUnknownResult(RoutePathPrefix)(pathPrefix);
    // Then
    expect(Result.isSuccess(decoded)).toBe(Result.isSuccess(parseRoutePathPrefix(pathPrefix)));
  },
);

test.each(["RouteHostname", "DomainName", "RoutePathPrefix", "HostAliasName", "CertificateName"] as const)(
  "publishes %s pattern",
  (name) => {
    // Given / When
    const json = getJsonSchema(name);
    // Then
    expect(JSON.stringify(json)).toMatch(/"pattern":|"format":|"anyOf":/);
  },
);

test("RoutePlan published JSON Schema keeps object properties", () => {
  // Given / When
  const json = getJsonSchema("RoutePlan");
  // Then
  expect(json.type).toBe("object");
  expect(json.properties).toMatchObject({
    hostname: expect.anything(),
    scheme: expect.anything(),
    service: expect.anything(),
    backend: expect.anything(),
  });
});

test("rejects a port-bearing RoutePlan hostname on decode and encode", () => {
  // Given
  const route = {
    hostname: "app.lndo.site:8080",
    scheme: "https",
    service: "web",
    backend: { service: "web", protocol: "http", port: 80 },
  };
  // When
  const decoded = Schema.decodeUnknownResult(RoutePlan)(route);
  const encoded = Schema.encodeUnknownResult(RoutePlan)(route);
  // Then
  expect(Result.isFailure(decoded)).toBe(true);
  expect(Result.isFailure(encoded)).toBe(true);
  if (Result.isFailure(decoded)) expect(decoded.failure.message).toContain("hostname");
});
