import { expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import {
  backendTransportName,
  decodeObservedTransportBody,
  observedTransportReference,
  planBackendTransports,
  rootPemIsUsable,
} from "../src/backend-transport.ts";
import { renderTraefikDynamicConfig, routeNamespace } from "../src/routing.ts";
import { routeObjectName, routeOwner } from "./route-owner-fixture.ts";

const app = routeOwner("backend-tls");
const namespace = routeNamespace(app);
const service0 = routeObjectName(app, 0);
const ROOT = TEST_CERTIFICATES.rootA;

const tlsRoute = (overrides: Partial<RoutePlan> = {}): RoutePlan => ({
  hostname: "demo.lndo.site",
  priority: 2,
  scheme: "https",
  service: ServiceName.make("web"),
  backend: {
    service: ServiceName.make("web"),
    protocol: "https",
    port: 443,
    host: "web.app.internal",
    tls: { caId: "mkcert", serverName: "web.app.internal" },
  },
  ...overrides,
});

interface RenderedConfig {
  readonly http: {
    readonly services: Record<string, { readonly loadBalancer: Record<string, unknown> }>;
    readonly serversTransports?: Record<string, unknown>;
  };
}

const parse = (yaml: string): RenderedConfig => Bun.YAML.parse(yaml) as RenderedConfig;

const render = (routes: ReadonlyArray<RoutePlan>) =>
  renderTraefikDynamicConfig(routes, app, undefined, planBackendTransports(routes, app, ROOT));

test("renders one verified serversTransport and references it from the load balancer", () => {
  // Given
  const route = tlsRoute();
  const plan = planBackendTransports([route], app, ROOT);
  const name = plan.references[0];
  // When
  const parsed = parse(render([route]));
  // Then
  expect(name).toBeDefined();
  expect(parsed.http.services[service0]).toEqual({
    loadBalancer: {
      passHostHeader: true,
      serversTransport: `${name}@file`,
      servers: [{ url: "https://web.app.internal:443" }],
    },
  });
  expect(parsed.http.serversTransports?.[name as string]).toEqual({
    serverName: "web.app.internal",
    rootCAs: [ROOT],
    insecureSkipVerify: false,
  });
});

test("dedupes identical transport identities and names them by full content digest", () => {
  // Given
  const first = tlsRoute();
  const second = tlsRoute({ hostname: "other.lndo.site" });
  // When
  const plan = planBackendTransports([first, second], app, ROOT);
  const parsed = parse(render([first, second]));
  // Then
  expect(plan.transports).toHaveLength(1);
  expect(plan.references[0]).toBe(plan.references[1]);
  expect(Object.keys(parsed.http.serversTransports ?? {})).toHaveLength(1);
  const expectedName = `${namespace}tls-${sha256Hex(
    canonicalJson({
      caId: "mkcert",
      config: { serverName: "web.app.internal", rootCAs: [ROOT], insecureSkipVerify: false },
    }),
  )}`;
  expect(plan.references[0]).toBe(expectedName);
  expect(expectedName.slice(namespace.length + "tls-".length)).toHaveLength(64);
});

test("changes the transport name when the root, SNI, or authority changes", () => {
  // Given
  const route = tlsRoute();
  const base = planBackendTransports([route], app, ROOT).references[0];
  // When
  const otherRoot = planBackendTransports([route], app, TEST_CERTIFICATES.rootB).references[0];
  const otherSni = planBackendTransports(
    [
      tlsRoute({
        backend: { ...tlsRoute().backend, tls: { caId: "mkcert", serverName: "web.other.internal" } },
      }),
    ],
    app,
    ROOT,
  ).references[0];
  const otherCa = planBackendTransports(
    [
      tlsRoute({
        backend: { ...tlsRoute().backend, tls: { caId: "other", serverName: "web.app.internal" } },
      }),
    ],
    app,
    ROOT,
  ).references[0];
  // Then
  expect(new Set([base, otherRoot, otherSni, otherCa]).size).toBe(4);
});

test("leaves custom HTTPS backends on the router's ordinary system trust", () => {
  // Given
  const custom: RoutePlan = {
    ...tlsRoute(),
    backend: {
      service: ServiceName.make("web"),
      protocol: "https",
      port: 8443,
      host: "edge.example.test",
      // No tls intent: an authored custom endpoint the router does not mint trust for.
    },
  };
  // When
  const parsed = parse(render([custom]));
  // Then
  expect(parsed.http.serversTransports).toBeUndefined();
  expect(parsed.http.services[service0]?.loadBalancer).toEqual({
    passHostHeader: true,
    servers: [{ url: "https://edge.example.test:8443" }],
  });
});

test("names the transport by the route's planned authority, not the router's CA handle", () => {
  // Given: the router's CA handle is resolved lazily and does not carry the
  // active authority's id, so only the planned caId can name the transport.
  const route = tlsRoute();
  // When
  const plan = planBackendTransports([route], app, ROOT);
  // Then
  expect(plan.transports).toEqual([
    {
      name: plan.references[0] as string,
      caId: "mkcert",
      config: { serverName: "web.app.internal", rootCAs: [ROOT], insecureSkipVerify: false },
    },
  ]);
});

test("plans no transport without root material", () => {
  expect(planBackendTransports([tlsRoute()], app, undefined)).toEqual({
    transports: [],
    references: [undefined],
    invalidRoot: false,
  });
});

test("observed inline transport re-hashes to the declared reference", () => {
  // Given
  const body = { serverName: "web.app.internal", rootCAs: [ROOT], insecureSkipVerify: false };
  const decoded = decodeObservedTransportBody(body);
  // When / Then
  expect(decoded._tag).toBe("Some");
  if (decoded._tag !== "Some") return;
  expect(observedTransportReference({ namespace, caId: "mkcert", body: decoded.value })).toBe(
    `${planBackendTransports([tlsRoute()], app, ROOT).references[0]}@file`,
  );
});

test.each([
  {
    label: "verification disabled",
    body: { serverName: "web.app.internal", rootCAs: [ROOT], insecureSkipVerify: true },
  },
  { label: "verification omitted", body: { serverName: "web.app.internal", rootCAs: [ROOT] } },
  {
    label: "extra field",
    body: {
      serverName: "web.app.internal",
      rootCAs: [ROOT],
      insecureSkipVerify: false,
      insecureSkipVerify2: true,
    },
  },
])("observed transport rejects $label", ({ body }) => {
  expect(decodeObservedTransportBody(body)._tag).toBe("None");
});

test("transport name changes with an edited body even under the same SNI", () => {
  const first = backendTransportName(namespace, "mkcert", {
    serverName: "web.app.internal",
    rootCAs: [ROOT],
    insecureSkipVerify: false,
  });
  const second = backendTransportName(namespace, "mkcert", {
    serverName: "web.app.internal",
    rootCAs: [TEST_CERTIFICATES.rootB],
    insecureSkipVerify: false,
  });
  expect(first).not.toBe(second);
});

test("rejects root material Traefik would silently discard", () => {
  // Given / When
  const valid = planBackendTransports([tlsRoute()], app, ROOT);
  const invalid = planBackendTransports([tlsRoute()], app, "not a certificate");
  // Then
  expect(rootPemIsUsable(ROOT)).toBe(true);
  expect(rootPemIsUsable("not a certificate")).toBe(false);
  expect(valid.invalidRoot).toBe(false);
  expect(invalid.invalidRoot).toBe(true);
});
