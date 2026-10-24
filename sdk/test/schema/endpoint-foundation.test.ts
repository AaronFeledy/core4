import { expect, test } from "bun:test";
import * as sdk from "@lando/sdk/schema";
import { Schema } from "effect";

const plans = (values: readonly unknown[]) =>
  values.map((value) => Schema.decodeUnknownSync(sdk.EndpointPlan)(value));

test("groups primary publications as one logical listener and preserves aliases", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
    { _tag: "published", protocol: "http", port: 80, name: "web", primary: true, publication: {} },
  ]);
  // When / Then
  expect(sdk.endpointInvariantIssues(endpoints)).toEqual([]);
  expect(sdk.groupLogicalEndpoints(endpoints)).toHaveLength(1);
  expect(sdk.selectHttpEndpoint(endpoints)).toMatchObject({
    status: "selected",
    endpoint: { names: ["web"], primary: true },
  });
});

test("selects the unique HTTP secondary instead of a TCP primary", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "tcp", port: 1025, primary: true },
    { _tag: "internal", protocol: "http", port: 8025 },
  ]);
  // When / Then
  expect(sdk.selectHttpEndpoint(endpoints)).toMatchObject({ status: "selected", endpoint: { port: 8025 } });
});

test("reports ambiguity without inventing primary order in old plans", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "http", port: 80 },
    { _tag: "internal", protocol: "https", port: 443 },
  ]);
  // When / Then
  expect(sdk.selectHttpEndpoint(endpoints).status).toBe("ambiguous");
  expect(sdk.selectHttpEndpoint(endpoints, 443)).toMatchObject({
    status: "selected",
    endpoint: { port: 443, primary: false },
  });
});

test("detects alias collisions and conflicting protocols including Unix aliases", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "http", port: 80, name: "web" },
    { _tag: "internal", protocol: "https", port: 80 },
    { _tag: "internal", protocol: "http", port: 81, name: "web" },
    { _tag: "internal", protocol: "unix", socketPath: "/run/web.sock", name: "web" },
  ]);
  // When / Then
  expect(
    sdk
      .endpointInvariantIssues(endpoints)
      .map((issue) => issue.kind)
      .sort(),
  ).toEqual(["alias-collision", "protocol-conflict"]);
  expect(sdk.selectHttpEndpoint(endpoints, "web").status).toBe("ambiguous");
});

test("keeps missing publication evidence distinct from observed empty bindings", () => {
  // Given / When / Then
  expect(() => Schema.decodeUnknownSync(sdk.PublicationObservation)({})).toThrow();
  expect(Schema.decodeUnknownSync(sdk.PublicationObservation)({ status: "present", bindings: [] })).toEqual({
    status: "present",
    bindings: [],
  });
});

test.each([sdk.EndpointInput, sdk.EndpointPlan])(
  "preserves optional network roles and rejects false or Unix primary roles",
  (schema) => {
    const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
    expect(decode({ _tag: "internal", protocol: "http", port: 80 })).toEqual({
      _tag: "internal",
      protocol: "http",
      port: 80,
    });
    expect(
      decode({ _tag: "internal", protocol: "http", port: 80, primary: true, appProtocol: "opaque" }),
    ).toMatchObject({ primary: true, appProtocol: "opaque" });
    expect(() => decode({ _tag: "internal", protocol: "http", port: 80, primary: false })).toThrow();
    expect(() =>
      decode({ _tag: "internal", protocol: "unix", socketPath: "/run/app.sock", primary: true }),
    ).toThrow();
  },
);

test("rejects pending app listeners and pending URLs even with default excess stripping", () => {
  // Given
  const pending = {
    host: "db",
    endpoint: { port: 5432, transport: "tcp", names: [], primary: true },
    protocol: "tcp",
    binding: "pending",
    state: "unknown",
  };
  // When / Then
  expect(() =>
    Schema.decodeUnknownSync(sdk.ServiceConnection)({ ...pending, scope: "app", source: "listener" }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(sdk.ServiceConnection)({
      ...pending,
      scope: "host",
      source: "publication",
      url: "tcp://db:5432",
    }),
  ).toThrow();
});

test("distinguishes primary identities across transports and resolves named aliases", () => {
  const endpoints = plans([
    { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
    {
      _tag: "published",
      protocol: "http",
      port: 80,
      name: "browser",
      primary: true,
      publication: { hostPort: 8080 },
    },
    { _tag: "internal", protocol: "udp", port: 80, primary: true },
  ]);
  expect(sdk.endpointInvariantIssues(endpoints)).toMatchObject([
    { kind: "multiple-primary", identities: ["80/tcp", "80/udp"] },
  ]);
  expect(sdk.selectHttpEndpoint(endpoints, "browser")).toMatchObject({
    status: "selected",
    endpoint: { names: ["browser", "web"] },
  });
  expect(sdk.logicalEndpointIdentity({ port: 80, transport: "tcp", names: [], primary: true })).toBe(
    "80/tcp",
  );
});

test("does not promote opaque appProtocol metadata or Unix sockets into HTTP selection", () => {
  const endpoints = plans([
    { _tag: "internal", protocol: "tcp", port: 8000, appProtocol: "http", primary: true },
    { _tag: "internal", protocol: "unix", socketPath: "/run/http.sock" },
  ]);
  expect(sdk.selectHttpEndpoint(endpoints)).toEqual({ status: "none" });
  expect(sdk.groupLogicalEndpoints(endpoints)).toHaveLength(1);
});

const reference = { port: 8080, transport: "tcp", names: ["web"], primary: true } as const;
const assigned = {
  host: "::1",
  endpoint: reference,
  binding: "assigned",
  port: 38080,
  url: "http://[::1]:38080/api",
  alternateUrls: [],
  state: "active",
} as const;

test.each([
  { ...assigned, scope: "app", source: "listener", protocol: "tcp" },
  { ...assigned, scope: "host", source: "publication", protocol: "http" },
  { ...assigned, scope: "host", source: "route", protocol: "http", pathPrefix: "/api" },
  {
    host: "127.0.0.1",
    endpoint: reference,
    scope: "host",
    source: "publication",
    protocol: "tcp",
    binding: "pending",
    state: "unknown",
  },
  {
    host: "app.lndo.site",
    endpoint: reference,
    scope: "host",
    source: "route",
    protocol: "https",
    pathPrefix: "/api",
    binding: "pending",
    state: "inactive",
  },
])("round trips a legal scoped connection: %j", (connection) => {
  const decoded = Schema.decodeUnknownSync(sdk.ServiceConnection)(connection);
  expect(Schema.encodeSync(sdk.ServiceConnection)(decoded)).toEqual(connection);
});

test.each([
  { ...assigned, scope: "host", source: "route", protocol: "udp", pathPrefix: "/api" },
  { ...assigned, scope: "app", source: "route", protocol: "http", pathPrefix: "/api" },
  { ...assigned, scope: "host", source: "route", protocol: "http" },
  {
    host: "localhost",
    endpoint: reference,
    scope: "host",
    source: "publication",
    protocol: "tcp",
    binding: "pending",
    state: "active",
  },
])("rejects an illegal scoped connection: %j", (connection) => {
  expect(() => Schema.decodeUnknownSync(sdk.ServiceConnection)(connection)).toThrow();
});

test("round trips observed publications without plan metadata", () => {
  const observation = {
    status: "present",
    bindings: [{ port: 8080, transport: "tcp", bindAddress: "::", hostPort: 49152 }],
  } as const;
  expect(
    Schema.encodeSync(sdk.PublicationObservation)(
      Schema.decodeUnknownSync(sdk.PublicationObservation)(observation),
    ),
  ).toEqual(observation);
});
