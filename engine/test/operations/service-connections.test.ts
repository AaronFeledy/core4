import { expect, test } from "bun:test";
import { publicationObservationFromInspect } from "@lando/container-runtime/podman/inspect";
import { ProviderId, ServiceConnection, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { DateTime, Schema } from "effect";
import {
  activeHostHttpAddresses,
  activeHostHttpUrls,
  projectServiceConnections,
} from "../../src/operations/service-connections.ts";

const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: {},
  mounts: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-23T00:00:00Z"), source: "test", runtime: 4 },
  endpoints: [
    { kind: "internal", protocol: "http", port: 3000, name: "web", primary: true },
    { kind: "published", protocol: "http", port: 3000, publication: { hostPort: 8080 } },
    { kind: "published", protocol: "http", port: 3000, publication: {} },
  ],
};

const connectionsFor = (input: Partial<Parameters<typeof projectServiceConnections>[0]>) =>
  projectServiceConnections({
    plan: { slug: "test" },
    service,
    state: "running",
    publications: { status: "unknown" },
    ...input,
  });

test("retains stopped fixed and pending configured connections without active URLs", () => {
  // Given / When
  const connections = connectionsFor({
    state: "stopped",
    publications: { status: "missing" },
  });
  // Then
  expect(connections.map((row) => [row.scope, row.binding, row.state])).toEqual([
    ["app", "assigned", "inactive"],
    ["host", "assigned", "inactive"],
    ["host", "pending", "inactive"],
  ]);
  expect(activeHostHttpUrls({ connections, routes: [] })).toEqual([]);
  expect(connections).toEqual(connections.map((row) => Schema.decodeUnknownSync(ServiceConnection)(row)));
});

test("preserves aliases while matching multiple actual bindings by IP and pinned host port", () => {
  const planned: ServicePlan = {
    ...service,
    endpoints: [
      { kind: "internal", protocol: "http", port: 3000, name: "z", primary: true },
      { kind: "published", protocol: "http", port: 3000, name: "a", publication: { hostPort: 8080 } },
      { kind: "published", protocol: "http", port: 3000, name: "z", publication: { bindAddress: "::1" } },
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
  const rows = connectionsFor({ service: planned, publications });
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
  const rows = connectionsFor({
    service: { ...service, endpoints: [service.endpoints[1]].filter((endpoint) => endpoint !== undefined) },
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
  const rows = connectionsFor({ publications: publicationObservationFromInspect(inspect) });
  expect(rows.filter((row) => row.scope === "host").map((row) => row.state)).toEqual([state, state]);
});

test("does not promote opaque app_protocol or conflicting protocol groups into HTTP", () => {
  const planned: ServicePlan = {
    ...service,
    endpoints: [
      {
        kind: "published",
        protocol: "tcp",
        port: 9000,
        appProtocol: "vendor.http+json",
        publication: { hostPort: 19000 },
      },
      { kind: "internal", protocol: "http", port: 3000 },
      { kind: "internal", protocol: "https", port: 3000 },
    ],
  };
  const rows = connectionsFor({ service: planned });
  expect(rows.map((row) => row.protocol)).toEqual(["tcp", "tcp", "tcp"]);
  expect(activeHostHttpUrls({ connections: rows, routes: [] })).toEqual([]);
});

test("uses canonical qualified listeners on aliasless shared-only topology", () => {
  const connections = connectionsFor({
    plan: {
      slug: "demo",
      networking: { perAppBridge: null, sharedNetworkMembership: { name: "shared", aliases: {} } },
    },
    state: "ready",
  });
  expect(connections.find((connection) => connection.scope === "app")).toMatchObject({
    host: "web.demo.internal",
    port: 3000,
    url: "http://web.demo.internal:3000",
  });
});

test("does not advertise an app listener when no managed network realizes it", () => {
  const connections = connectionsFor({
    plan: { slug: "demo", networking: { perAppBridge: null } },
    state: "ready",
  });
  expect(connections.filter((connection) => connection.scope === "app")).toEqual([]);
  expect(connections.filter((connection) => connection.scope === "host")).toHaveLength(2);
});
test("selects only assigned active host HTTP addresses, publications before exact routes", () => {
  const endpoint = { port: 3000, transport: "tcp", names: ["web"], primary: true } as const;
  const base = { host: "localhost", protocol: "http", endpoint } as const;
  const publication = { ...base, scope: "host", source: "publication" } as const;
  const assigned = {
    ...publication,
    binding: "assigned",
    state: "active",
    port: 8080,
    url: "http://localhost:8080",
    alternateUrls: [],
  } as const;
  const route = { ...base, host: "web.test", protocol: "https", pathPrefix: "/api" } as const;
  const addresses = activeHostHttpAddresses({
    connections: [
      { ...assigned, scope: "app", source: "listener" },
      { ...publication, binding: "pending", state: "unknown" },
      { ...assigned, state: "inactive" },
      { ...assigned, protocol: "tcp", url: "tcp://localhost:8080" },
      assigned,
    ],
    routes: [
      { ...route, host: "*.test", hostMatch: "pattern", binding: "assigned", state: "active", port: 443 },
      { ...route, hostMatch: "exact", binding: "pending", state: "inactive" },
      {
        ...route,
        hostMatch: "exact",
        binding: "assigned",
        state: "inactive",
        port: 8443,
        url: "https://web.test:8443/api",
      },
      {
        ...route,
        hostMatch: "exact",
        binding: "assigned",
        state: "active",
        port: 443,
        url: "https://web.test/api",
      },
    ],
  });
  expect(addresses).toEqual([
    { ...base, via: "publication", pathPrefix: "", url: "http://localhost:8080" },
    { ...route, via: "route", url: "https://web.test/api" },
  ]);
});

test.each(["starting", "restarting", "unknown"] as const)(
  "keeps %s host activity unknown despite an assigned binding",
  (state) => {
    const rows = connectionsFor({
      state,
      publications: {
        status: "present",
        bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
      },
    });
    expect(rows.map((row) => row.state)).toEqual(["unknown", "unknown", "inactive"]);
    expect(activeHostHttpUrls({ connections: rows, routes: [] })).toEqual([]);
  },
);

test("matches observed assignments and leaves unknown extra bindings generic", () => {
  // Given / When
  const connections = connectionsFor({
    state: "ready",
    publications: {
      status: "present",
      bindings: [
        { port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 },
        { port: 9000, transport: "tcp", bindAddress: "::", hostPort: 19000 },
      ],
    },
  });
  // Then
  expect(activeHostHttpUrls({ connections, routes: [] })).toEqual(["http://localhost:8080"]);
  expect(connections.at(-1)).toMatchObject({
    protocol: "tcp",
    host: "::1",
    url: "tcp://[::1]:19000",
    endpoint: { names: [], primary: false },
  });
});

test.each(["unknown", "present"] as const)("keeps absent publications honest for %s evidence", (status) => {
  // Given / When
  const connections = connectionsFor({
    publications: status === "unknown" ? { status } : { status, bindings: [] },
  });
  // Then
  expect(connections.filter((row) => row.scope === "host").map((row) => row.state)).toEqual(
    status === "unknown" ? ["unknown", "unknown"] : ["inactive", "inactive"],
  );
});
