import { expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { DateTime } from "effect";
import { projectServiceConnections } from "../../src/operations/service-connections.ts";

const dynamic = { _tag: "published", protocol: "http", port: 3000, publication: {} } as const;
const fixed = { ...dynamic, publication: { hostPort: 8080 } };
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("podman"),
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "mixed-publications", runtime: 4 },
  endpoints: [dynamic, { ...dynamic, name: "alias" }, fixed],
};

test("keeps dynamic intent pending when only its sibling fixed binding is observed", () => {
  // Given a fixed binding and an unassigned dynamic alias group on the same listener.
  const publications = {
    status: "present",
    bindings: [{ port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
  } as const;
  // When
  const rows = projectServiceConnections({
    plan: { slug: "test" },
    service,
    state: "running",
    publications,
    routes: [],
  });
  // Then
  expect(
    rows
      .filter((row) => row.scope === "host")
      .map((row) => [row.binding, row.binding === "assigned" ? row.port : undefined, row.state]),
  ).toEqual([
    ["pending", undefined, "inactive"],
    ["assigned", 8080, "active"],
  ]);
});

test("assigns dynamic aliases only to unreserved physical bindings across IP and UDP", () => {
  // Given
  const planned: ServicePlan = {
    ...service,
    endpoints: [
      ...service.endpoints,
      { ...dynamic, publication: { bindAddress: "::1" } },
      { ...dynamic, protocol: "udp" },
    ],
  };
  const publications = {
    status: "present",
    bindings: [
      { port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 },
      { port: 3000, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 30000 },
      { port: 3000, transport: "tcp", bindAddress: "::1", hostPort: 8080 },
      { port: 3000, transport: "udp", bindAddress: "127.0.0.1", hostPort: 8080 },
    ],
  } as const;
  // When
  const rows = projectServiceConnections({
    plan: { slug: "test" },
    service: planned,
    state: "running",
    publications,
    routes: [],
  });
  // Then aliases share a single assigned physical binding, with typed listener metadata.
  expect(
    rows
      .filter((row) => row.scope === "host")
      .map((row) => [row.protocol, row.host, row.binding === "assigned" ? row.port : "pending"]),
  ).toEqual([
    ["http", "localhost", 30000],
    ["http", "localhost", 8080],
    ["http", "::1", 8080],
    ["udp", "localhost", 8080],
  ]);
});
