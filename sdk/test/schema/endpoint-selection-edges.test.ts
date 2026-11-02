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
