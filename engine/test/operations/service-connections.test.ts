import { expect, test } from "bun:test";
import { publicationObservationFromInspect } from "@lando/container-runtime/podman/inspect";
import { ProviderId, ServiceConnection, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { DateTime, Schema } from "effect";
import { activeHostHttpUrls, projectServiceConnections } from "../../src/operations/service-connections.ts";

const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-23T00:00:00Z"), source: "test", runtime: 4 },
  endpoints: [
    { _tag: "internal", protocol: "http", port: 3000, name: "web", primary: true },
    { _tag: "published", protocol: "http", port: 3000, publication: { hostPort: 8080 } },
    { _tag: "published", protocol: "http", port: 3000, publication: {} },
  ],
};

test("retains stopped fixed and pending configured connections without active URLs", () => {
  // Given / When
  const connections = projectServiceConnections({
    service,
    state: "stopped",
    publications: { status: "missing" },
    routes: [],
  });
  // Then
  expect(connections.map((row) => [row.scope, row.binding, row.state])).toEqual([
    ["app", "assigned", "inactive"],
    ["host", "assigned", "inactive"],
    ["host", "pending", "inactive"],
  ]);
  expect(activeHostHttpUrls(connections)).toEqual([]);
  expect(connections).toEqual(connections.map((row) => Schema.decodeUnknownSync(ServiceConnection)(row)));
});

test("preserves aliases while matching multiple actual bindings by IP and pinned host port", () => {
  const planned: ServicePlan = {
    ...service,
    endpoints: [
      { _tag: "internal", protocol: "http", port: 3000, name: "z", primary: true },
      { _tag: "published", protocol: "http", port: 3000, name: "a", publication: { hostPort: 8080 } },
      { _tag: "published", protocol: "http", port: 3000, name: "z", publication: { bindAddress: "::1" } },
    ],
  };
  const publications = publicationObservationFromInspect({
    NetworkSettings: {
      Ports: {
        "3000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "8080" },
          { HostIp: "::1", HostPort: "48000" },
          { HostIp: "127.0.0.1", HostPort: "9090" },
        ],
      },
    },
  });
  const rows = projectServiceConnections({ service: planned, state: "running", routes: [], publications });
  expect(rows.filter((row) => row.scope === "app")).toHaveLength(1);
  expect(rows.slice(0, 3).map((row) => row.endpoint)).toEqual(
    Array.from({ length: 3 }, () => ({ port: 3000, transport: "tcp", names: ["a", "z"], primary: true })),
  );
  expect(rows.at(-1)).toMatchObject({
    protocol: "tcp",
    url: "tcp://localhost:9090",
    endpoint: { names: [], primary: false },
  });
});

test("retains unmatched fixed intent when an observed binding has another IP or host port", () => {
  const rows = projectServiceConnections({
    service: { ...service, endpoints: [service.endpoints[1]].filter((endpoint) => endpoint !== undefined) },
    state: "running",
    routes: [],
    publications: {
      status: "present",
      bindings: [{ port: 3000, transport: "tcp", bindAddress: "0.0.0.0", hostPort: 9090 }],
    },
  });
  expect(rows.find((row) => row.source === "publication" && row.protocol === "http")).toMatchObject({
    url: "http://localhost:8080",
    state: "inactive",
  });
  expect(rows.at(-1)).toMatchObject({ url: "tcp://localhost:9090", state: "active" });
});

test.each([
  [{}, "unknown"],
  [{ NetworkSettings: { Ports: {} } }, "inactive"],
  [{ NetworkSettings: { Ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "broken" }] } } }, "unknown"],
] as const)("keeps missing and malformed inspect evidence distinct from known empty", (inspect, state) => {
  const rows = projectServiceConnections({
    service,
    state: "running",
    routes: [],
    publications: publicationObservationFromInspect(inspect),
  });
  expect(rows.filter((row) => row.scope === "host").map((row) => row.state)).toEqual([state, state]);
});

test("does not promote opaque app_protocol or conflicting protocol groups into HTTP", () => {
  const planned: ServicePlan = {
    ...service,
    endpoints: [
      {
        _tag: "published",
        protocol: "tcp",
        port: 9000,
        appProtocol: "vendor.http+json",
        publication: { hostPort: 19000 },
      },
      { _tag: "internal", protocol: "http", port: 3000 },
      { _tag: "internal", protocol: "https", port: 3000 },
    ],
  };
  const rows = projectServiceConnections({
    service: planned,
    state: "running",
    routes: [],
    publications: { status: "unknown" },
  });
  expect(rows.map((row) => row.protocol)).toEqual(["tcp", "tcp", "tcp"]);
  expect(activeHostHttpUrls(rows)).toEqual([]);
});

const route = {
  hostname: "web.example.test",
  scheme: "both",
  priority: 2,
  service: service.name,
  pathPrefix: "/api",
  backend: { service: service.name, protocol: "http", port: 3000, host: "web.internal" },
} as const;
const authorities = [
  { hostname: route.hostname, scheme: "http", port: 80 },
  { hostname: route.hostname, scheme: "https", port: 443 },
] as const;

test("retains both external schemes, default ports and path prefixes with live route evidence", () => {
  const rows = projectServiceConnections({
    service,
    state: "ready",
    publications: { status: "unknown" },
    routes: [route],
    routeEvidence: {
      configuredAuthorities: authorities,
      observation: {
        status: "present",
        publications: authorities.map((authority) => ({ route, authority })),
      },
    },
  });
  expect(activeHostHttpUrls(rows)).toEqual(["http://web.example.test/api", "https://web.example.test/api"]);
});

test.each(["host", "path", "scheme"] as const)(
  "rejects route evidence with a mismatched backend or route %s",
  (part) => {
    const other = {
      ...route,
      ...(part === "host" ? { backend: { ...route.backend, host: "foreign.internal" } } : {}),
      ...(part === "path" ? { pathPrefix: "/other" } : {}),
      ...(part === "scheme" ? { scheme: "https" as const } : {}),
    };
    const rows = projectServiceConnections({
      service,
      state: "running",
      publications: { status: "unknown" },
      routes: [route],
      routeEvidence: {
        configuredAuthorities: authorities,
        observation: {
          status: "present",
          publications: authorities.map((authority) => ({ route: other, authority })),
        },
      },
    });
    expect(rows.filter((row) => row.source === "route").map((row) => row.state)).toEqual([
      "inactive",
      "inactive",
    ]);
  },
);

test.each(["starting", "restarting", "unknown"] as const)(
  "keeps %s host activity unknown despite an assigned binding",
  (state) => {
    const rows = projectServiceConnections({
      service,
      state,
      routes: [],
      publications: {
        status: "present",
        bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
      },
    });
    expect(rows.map((row) => row.state)).toEqual(["unknown", "unknown", "inactive"]);
    expect(activeHostHttpUrls(rows)).toEqual([]);
  },
);

test("matches observed assignments and leaves unknown extra bindings generic", () => {
  // Given / When
  const connections = projectServiceConnections({
    service,
    state: "ready",
    routes: [],
    publications: {
      status: "present",
      bindings: [
        { port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 },
        { port: 9000, transport: "tcp", bindAddress: "::", hostPort: 19000 },
      ],
    },
  });
  // Then
  expect(activeHostHttpUrls(connections)).toEqual(["http://localhost:8080"]);
  expect(connections.at(-1)).toMatchObject({
    protocol: "tcp",
    host: "::1",
    url: "tcp://[::1]:19000",
    endpoint: { names: [], primary: false },
  });
});

test.each(["unknown", "present"] as const)("keeps absent publications honest for %s evidence", (status) => {
  // Given / When
  const connections = projectServiceConnections({
    service,
    state: "running",
    routes: [],
    publications: status === "unknown" ? { status } : { status, bindings: [] },
  });
  // Then
  expect(connections.filter((row) => row.scope === "host").map((row) => row.state)).toEqual(
    status === "unknown" ? ["unknown", "unknown"] : ["inactive", "inactive"],
  );
});
