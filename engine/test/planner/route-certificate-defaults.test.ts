import { expect, test } from "bun:test";
import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import type { CertificatePlan, RoutePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  applyRouteDemandedCertificates,
  stampGeneratedBackendTls,
} from "../../src/planner/route-certificate-defaults.ts";
import { makeRouteAccumulator } from "../../src/planner/route-identity.ts";

const resolution = (overrides: Partial<ServiceTypeResolution> = {}): ServiceTypeResolution => ({
  base: "lando",
  normalizedConfig: { type: "php:8.3" },
  features: [],
  generatedCertificateEndpoint: { port: 443 },
  ...overrides,
});

const demandFor = (input: {
  readonly resolution?: ServiceTypeResolution;
  readonly routes?: ReadonlyMap<string, readonly NormalizedRoute[] | undefined>;
  readonly routerEnabled?: boolean;
}) =>
  applyRouteDemandedCertificates({
    services: [{ name: "web", resolution: input.resolution ?? resolution() }],
    routes: input.routes ?? new Map(),
    routerEnabled: input.routerEnabled ?? true,
  })[0]?.resolution.normalizedConfig.certs;

test.each([
  { label: "default HTTPS discovery", routes: new Map() },
  {
    label: "authored HTTPS route",
    routes: new Map([["web", [{ hostname: "app.test", scheme: "https" as const, filters: [] }]]]),
  },
  {
    label: "authored both route",
    routes: new Map([["web", [{ hostname: "app.test", scheme: "both" as const, filters: [] }]]]),
  },
  {
    label: "numeric selector naming the generated listener",
    routes: new Map([
      ["web", [{ hostname: "app.test", scheme: "https" as const, endpoint: 443, filters: [] }]],
    ]),
  },
])("materializes a generated certificate for $label", ({ routes }) => {
  expect(demandFor({ routes })).toBe(true);
});

test.each([
  {
    label: "authored HTTP-only route",
    routes: new Map([["web", [{ hostname: "app.test", scheme: "http" as const, filters: [] }]]]),
  },
  { label: "explicitly empty route list", routes: new Map([["web", []]]) },
  {
    label: "authored HTTP or string selector",
    routes: new Map([
      ["web", [{ hostname: "app.test", scheme: "https" as const, endpoint: "web", filters: [] }]],
    ]),
  },
  {
    label: "numeric selector naming another listener",
    routes: new Map([
      ["web", [{ hostname: "app.test", scheme: "https" as const, endpoint: 8080, filters: [] }]],
    ]),
  },
])("keeps certificate demand off for an $label", ({ routes }) => {
  expect(demandFor({ routes })).toBeUndefined();
});

test.each([
  { label: "router disabled", routerEnabled: false, resolution: resolution() },
  {
    label: "explicit certs false",
    routerEnabled: true,
    resolution: resolution({ normalizedConfig: { type: "php:8.3", certs: false } }),
    expected: false,
  },
  {
    label: "custom certificate material",
    routerEnabled: true,
    resolution: resolution({ normalizedConfig: { type: "php:8.3", certs: "certs/site.crt" } }),
    expected: "certs/site.crt",
  },
  {
    label: "non-root parent",
    routerEnabled: true,
    resolution: resolution({ normalizedConfig: { type: "php:8.3", user: "www-data" } }),
  },
  {
    label: "endpoint override with no HTTPS listener",
    routerEnabled: true,
    resolution: resolution({
      normalizedConfig: {
        type: "php:8.3",
        endpoints: [{ _tag: "internal", protocol: "http", port: 80, primary: true }],
      },
    }),
  },
  {
    label: "blocked authored route expression",
    routerEnabled: true,
    resolution: resolution({ normalizedConfig: { type: "php:8.3", routes: ["{{ broken"] } }),
  },
  {
    label: "no generated-listener association",
    routerEnabled: true,
    resolution: {
      base: "lando" as const,
      normalizedConfig: { type: "php:8.3" },
      features: [],
    },
  },
])("never demands a certificate for $label", ({ routerEnabled, resolution: resolved, expected }) => {
  expect(demandFor({ resolution: resolved, routerEnabled })).toEqual(expected);
});

test("keeps numeric root parent spellings eligible and explicit certs true untouched", () => {
  // Given
  const explicit = resolution({ normalizedConfig: { type: "php:8.3", certs: true } });
  // When / Then
  expect(demandFor({ resolution: explicit })).toBe(true);
  expect(demandFor({ resolution: resolution({ normalizedConfig: { type: "php:8.3", user: "0:0" } }) })).toBe(
    true,
  );
  expect(
    demandFor({ resolution: resolution({ normalizedConfig: { type: "php:8.3", user: "root:root" } }) }),
  ).toBe(true);
});

test("demands the certificate for a route naming an authored HTTPS endpoint on the generated port", () => {
  // Given
  const authored = resolution({
    normalizedConfig: {
      type: "php:8.3",
      endpoints: [
        { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
        { _tag: "internal", protocol: "https", port: 443, name: "secure" },
      ],
    },
  });
  const routes = (endpoint: string) =>
    new Map([["web", [{ hostname: "app.test", scheme: "https" as const, endpoint, filters: [] }]]]);
  // When / Then
  expect(demandFor({ resolution: authored, routes: routes("secure") })).toBe(true);
  expect(demandFor({ resolution: authored, routes: routes("web") })).toBeUndefined();
});

test("keeps the generated association for an authored endpoint that names its listener", () => {
  // Given
  const authored = resolution({
    normalizedConfig: {
      type: "php:8.3",
      endpoints: [
        { _tag: "internal", protocol: "https", port: 443, name: "web" },
        { _tag: "internal", protocol: "http", port: 80, primary: true },
      ],
    },
  });
  // When / Then
  expect(demandFor({ resolution: authored })).toBe(true);
});

const plan = (overrides: Partial<RoutePlan> = {}): RoutePlan => ({
  priority: 2,
  hostname: "app.test",
  scheme: "https",
  service: ServiceName.make("web"),
  backend: { service: ServiceName.make("web"), protocol: "https", port: 443 },
  ...overrides,
});

const certificate: CertificatePlan = { cn: "web.app.internal", sans: ["web.app.internal"], caId: "mkcert" };

test.each([443, 8443])(
  "stamps verified TLS intent on an HTTPS backend of a service holding a generated certificate (port %d)",
  (port) => {
    // Given / When: the generated Apache listener or an authored HTTPS listener alike.
    const [stamped] = stampGeneratedBackendTls(
      [plan({ backend: { service: ServiceName.make("web"), protocol: "https", port } })],
      { certificate, generated: true },
    );
    // Then
    expect(stamped?.backend).toEqual({
      service: ServiceName.make("web"),
      protocol: "https",
      port,
      host: "web.app.internal",
      tls: { caId: "mkcert", serverName: "web.app.internal" },
    });
  },
);

test.each([
  {
    label: "no generated certificate",
    input: { certificate, generated: false },
  },
  {
    label: "custom certificate material",
    input: { certificate: undefined, generated: false },
  },
  {
    label: "the plan selected the plain listener",
    input: { certificate, generated: true },
    route: plan({ backend: { service: ServiceName.make("web"), protocol: "http", port: 80 } }),
  },
])("leaves backend TLS intent absent for $label", ({ input, route }) => {
  const [unstamped] = stampGeneratedBackendTls([route ?? plan()], input);
  expect(unstamped?.backend.tls).toBeUndefined();
});

test("an HTTP route to an HTTPS listener still verifies the backend", () => {
  // Given: the public scheme does not change what the backend speaks.
  const [stamped] = stampGeneratedBackendTls([plan({ scheme: "http" })], { certificate, generated: true });
  // Then
  expect(stamped?.backend.tls).toEqual({ caId: "mkcert", serverName: "web.app.internal" });
});

test("routes differing only in backend TLS intent conflict instead of deduping", async () => {
  // Given
  const accumulator = makeRouteAccumulator();
  await Effect.runPromise(accumulator.add(plan(), { key: "routes[0]" }));
  // When
  const result = await Effect.runPromise(
    Effect.result(
      accumulator.add(
        plan({ backend: { ...plan().backend, tls: { caId: "other", serverName: "web.app.internal" } } }),
        { key: "routes[1]" },
      ),
    ),
  );
  // Then
  expect(result._tag).toBe("Failure");
});
