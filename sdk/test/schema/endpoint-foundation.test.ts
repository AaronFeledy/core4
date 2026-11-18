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

test("preserves optional network roles on EndpointPlan and rejects false or Unix primary roles", () => {
  const decode = Schema.decodeUnknownSync(sdk.EndpointPlan, { onExcessProperty: "error" });
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
});

test("preserves optional network roles on EndpointInput wire and rejects false or Unix primary roles", () => {
  const decode = Schema.decodeUnknownSync(sdk.EndpointInput, { onExcessProperty: "error" });
  expect(decode({ kind: "internal", protocol: "http", port: 80 })).toEqual({
    _tag: "internal",
    protocol: "http",
    port: 80,
  });
  expect(
    decode({ kind: "internal", protocol: "http", port: 80, primary: true, appProtocol: "opaque" }),
  ).toMatchObject({ primary: true, appProtocol: "opaque" });
  expect(() => decode({ kind: "internal", protocol: "http", port: 80, primary: false })).toThrow();
  expect(() =>
    decode({ kind: "internal", protocol: "unix", socketPath: "/run/app.sock", primary: true }),
  ).toThrow();
});

const decodeInput = Schema.decodeUnknownSync(sdk.EndpointInput, { onExcessProperty: "error" });
const encodeInput = Schema.encodeSync(sdk.EndpointInput);
const roundTripInput = (wire: unknown) => {
  const once = decodeInput(wire);
  const encoded = encodeInput(once) as { readonly kind: string };
  expect(typeof encoded.kind).toBe("string");
  expect(Object.hasOwn(encoded, "_tag")).toBe(false);
  expect(decodeInput(encoded)).toEqual(once);
  return once;
};

test.each([
  "http:80",
  "https:443",
  "tcp:1",
  "udp:65535",
  "ui=http:8080",
  "UI=https:443",
  "a1_b-c=tcp:9",
] as const)("strict EndpointInput codec law holds for shorthand %s", (wire) => {
  roundTripInput(wire);
});

test.each([
  { kind: "internal", protocol: "http", port: 80, primary: true, appProtocol: "opaque", name: "web" },
  { kind: "internal", protocol: "unix", socketPath: "/run/app.sock", name: "sock" },
  { kind: "published", protocol: "http", port: 8080, publication: {} },
  {
    kind: "published",
    protocol: "tcp",
    port: 53,
    name: "dns",
    publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
  },
] as const)("strict EndpointInput codec law holds for object %j", (wire) => {
  roundTripInput(wire);
});

test.each([
  "http",
  ":80",
  "http:0",
  "http:65536",
  "http:080",
  "http:-1",
  "http:1.5",
  "http:1e2",
  "=http:80",
  "ui=HTTP:80",
  "ui =http:80",
  " http:80",
  "http:80\n",
  "smtp:25",
  "http:80 ",
] as const)("rejects invalid EndpointInput shorthand %j", (wire) => {
  expect(() => decodeInput(wire)).toThrow(/protocol:port|kind: internal/);
});

test.each([
  { _tag: "internal", protocol: "http", port: 80 },
  { kind: "internal", _tag: "internal", protocol: "http", port: 80 },
  { kind: "internal", protocol: "http", port: 80, scan: { path: "/health" } },
  { kind: "published", protocol: "unix", socketPath: "/run/app.sock", publication: {} },
] as const)("rejects legacy or excess EndpointInput wire %j", (wire) => {
  expect(() => decodeInput(wire)).toThrow();
});

test.each([1, 9, 10, 9999, 10000, 59999, 60000, 64999, 65000, 65499, 65500, 65529, 65530, 65535] as const)(
  "shorthand port %i agrees with PortNumber and the codec",
  (port) => {
    const wire = `http:${port}`;
    const decoded = roundTripInput(wire);
    expect(decoded).toEqual({ _tag: "internal", protocol: "http", port });
    expect(Schema.decodeUnknownSync(sdk.PortNumber)(port)).toBe(port);
  },
);

test.each([0, 65536] as const)("rejects port boundary %i in both PortNumber and shorthand", (port) => {
  expect(() => Schema.decodeUnknownSync(sdk.PortNumber)(port)).toThrow();
  expect(() => decodeInput(`http:${port}`)).toThrow();
});

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
