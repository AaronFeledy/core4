import { expect, test } from "bun:test";
import {
  EndpointPlan,
  HttpEndpointSelection,
  endpointInvariantIssues,
  groupLogicalEndpoints,
  selectHttpEndpoint,
} from "@lando/sdk/schema";
import { Schema } from "effect";

const plans = Schema.decodeUnknownSync(Schema.Array(EndpointPlan));

test("selects explicit HTTP port when a valid UDP listener shares that port", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "http", port: 80, primary: true },
    { _tag: "internal", protocol: "udp", port: 80 },
  ]);
  // When
  const selection = selectHttpEndpoint(endpoints, 80);
  // Then
  expect(endpointInvariantIssues(endpoints)).toEqual([]);
  expect(selection).toMatchObject({
    status: "selected",
    endpoint: { port: 80, transport: "tcp", protocol: "http", primary: true },
  });
});

test.each([
  { transport: "tcp", protocol: "tcp" },
  { transport: "udp", protocol: "http" },
])("rejects a selected HTTP result with incompatible protocol metadata: %j", (protocols) => {
  const selection = {
    status: "selected",
    endpoint: { port: 80, names: [], primary: false, ...protocols },
  };
  expect(() => Schema.decodeUnknownSync(HttpEndpointSelection)(selection)).toThrow();
});

test.each([
  {
    first: { _tag: "internal", protocol: "http", port: 80, name: "shared" },
    identities: ["80/tcp", "unix:/run/web.sock"],
  },
  {
    first: { _tag: "internal", protocol: "unix", socketPath: "/run/other.sock", name: "shared" },
    identities: ["unix:/run/other.sock", "unix:/run/web.sock"],
  },
])("rejects alias ownership across distinct listeners: %j", ({ first, identities }) => {
  // Given
  const endpoints = plans([
    first,
    { _tag: "internal", protocol: "unix", socketPath: "/run/web.sock", name: "shared" },
  ]);
  // When
  const issues = endpointInvariantIssues(endpoints);
  // Then
  expect(issues).toEqual([{ kind: "alias-collision", name: "shared", identities }]);
});

test("allows repeated aliases on one Unix socket without creating a network listener", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "unix", socketPath: "/run/web.sock", name: "shared" },
    { _tag: "internal", protocol: "unix", socketPath: "/run/web.sock", name: "shared" },
  ]);
  // When
  const issues = endpointInvariantIssues(endpoints);
  // Then
  expect(issues).toEqual([]);
  expect(groupLogicalEndpoints(endpoints)).toEqual([]);
});

test.each([
  { preferred: "https" as const, port: 443, protocol: "https" },
  { preferred: "http" as const, port: 80, protocol: "http" },
  { preferred: undefined, port: 80, protocol: "http" },
])("prefers an available $preferred listener under an HTTP primary", ({ preferred, port, protocol }) => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
    { _tag: "internal", protocol: "https", port: 443, name: "web-https" },
  ]);
  // When
  const selection = selectHttpEndpoint(endpoints, undefined, preferred);
  // Then
  expect(selection).toMatchObject({ status: "selected", endpoint: { port, protocol } });
});

test("falls back to the HTTP(S) set when no listener serves the preferred protocol", () => {
  // Given
  const endpoints = plans([{ _tag: "internal", protocol: "http", port: 80, primary: true }]);
  // When
  const selection = selectHttpEndpoint(endpoints, undefined, "https");
  // Then
  expect(selection).toMatchObject({ status: "selected", endpoint: { port: 80, protocol: "http" } });
});

test("keeps ambiguity between two preferred-protocol listeners", () => {
  // Given
  const endpoints = plans([
    { _tag: "internal", protocol: "https", port: 443, name: "a" },
    { _tag: "internal", protocol: "https", port: 8443, name: "b" },
  ]);
  // When
  const selection = selectHttpEndpoint(endpoints, undefined, "https");
  // Then
  expect(selection.status).toBe("ambiguous");
});

test.each([{ selector: "web" as const }, { selector: 80 as const }])(
  "ignores the scheme preference when an authored selector names a listener: %j",
  ({ selector }) => {
    // Given
    const endpoints = plans([
      { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
      { _tag: "internal", protocol: "https", port: 443, name: "web-https" },
    ]);
    // When
    const selection = selectHttpEndpoint(endpoints, selector, "https");
    // Then
    expect(selection).toMatchObject({ status: "selected", endpoint: { port: 80, protocol: "http" } });
  },
);
