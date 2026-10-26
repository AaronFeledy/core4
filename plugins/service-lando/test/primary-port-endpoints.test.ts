import { expect, test } from "bun:test";
import { ServiceConfig, groupLogicalEndpoints, selectHttpEndpoint } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Schema } from "effect";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { nginxServiceType } from "../src/services/nginx.ts";
import { node22ServiceType } from "../src/services/node.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planService = (serviceType: ServiceType, service: ServiceConfig) =>
  composeServicePlan({
    serviceType,
    service,
    serviceName: "server",
    appRoot: "/srv/apps/primary-port",
    metadata: { resolvedAt: "2026-10-23T00:00:00Z", source: "primary-port-endpoints", runtime: 4 },
  });

test("retains the MariaDB primary listener when only another port is published", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "mariadb",
    port: 3307,
    ports: ["8080:80"],
    creds: { user: "app", database: "app", password: { _tag: "SecretRef", reference: "PRIMARY_DB" } },
  });
  // When
  const plan = await planService(mariadbServiceType, service);
  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "internal", port: 3307, protocol: "tcp", name: "server", primary: true },
    { _tag: "published", port: 80, protocol: "tcp", publication: { hostPort: 8080 } },
  ]);
  expect(plan.serviceTypeId).toBe("mariadb");
  expect(plan.connection).toMatchObject({
    family: "mariadb",
    port: 3307,
    creds: { password: { _tag: "SecretRef", reference: "PRIMARY_DB" } },
  });
  expect(plan.environment.MYSQL_PASSWORD).toEqual({ _tag: "SecretRef", reference: "PRIMARY_DB" });
});

test("keeps a matching publication as a facet of the same primary listener", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "mariadb",
    port: 3307,
    ports: ["127.0.0.1:13307:3307"],
  });
  // When
  const plan = await planService(mariadbServiceType, service);
  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "internal", port: 3307, protocol: "tcp", name: "server", primary: true },
    {
      _tag: "published",
      port: 3307,
      protocol: "tcp",
      name: "server",
      primary: true,
      publication: { bindAddress: "127.0.0.1", hostPort: 13307 },
    },
  ]);
  expect(groupLogicalEndpoints(plan.endpoints)).toEqual([
    { port: 3307, transport: "tcp", primary: true, names: ["server"], protocols: ["tcp"] },
  ]);
});

test.each([nginxServiceType, node22ServiceType])(
  "$id preserves primary role and authored metadata without classifying unknown ports as HTTP",
  async (serviceType) => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: serviceType.id,
      port: 3187,
      ports: [
        "13188:3188",
        { target: 3187, published: 13187, host_ip: "127.0.0.1", name: "primary", app_protocol: "http" },
        "23187:3187",
        "13189:3189",
      ],
    });
    // When
    const plan = await planService(serviceType, service);
    // Then
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 3187, protocol: "http", name: "server", primary: true },
      { _tag: "published", port: 3188, protocol: "tcp", publication: { hostPort: 13188 } },
      {
        _tag: "published",
        port: 3187,
        protocol: "http",
        name: "primary",
        primary: true,
        appProtocol: "http",
        publication: { bindAddress: "127.0.0.1", hostPort: 13187 },
      },
      {
        _tag: "published",
        port: 3187,
        protocol: "http",
        primary: true,
        name: "server",
        publication: { hostPort: 23187 },
      },
      { _tag: "published", port: 3189, protocol: "tcp", publication: { hostPort: 13189 } },
    ]);
    expect(selectHttpEndpoint([...plan.endpoints].reverse())).toEqual({
      status: "selected",
      endpoint: {
        port: 3187,
        protocol: "http",
        transport: "tcp",
        primary: true,
        names: ["primary", "server"],
      },
    });
  },
);

test("retains TCP when UDP publishes the same port number", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "mariadb",
    port: 3307,
    ports: ["13307:3307/udp"],
  });
  // When
  const plan = await planService(mariadbServiceType, service);
  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "internal", port: 3307, protocol: "tcp", name: "server", primary: true },
    { _tag: "published", port: 3307, protocol: "udp", publication: { hostPort: 13307 } },
  ]);
});

test("selects the TCP publication when UDP with the same port is authored first", async () => {
  // Given
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "node:22",
    port: 3187,
    ports: ["13187:3187/udp", "13188:3188", "23187:3187/tcp"],
  });
  // When
  const plan = await planService(node22ServiceType, service);
  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "internal", port: 3187, protocol: "http", primary: true, name: "server" },
    { _tag: "published", port: 3187, protocol: "udp", publication: { hostPort: 13187 } },
    { _tag: "published", port: 3188, protocol: "tcp", publication: { hostPort: 13188 } },
    {
      _tag: "published",
      port: 3187,
      protocol: "http",
      primary: true,
      name: "server",
      publication: { hostPort: 23187 },
    },
  ]);
});

test.each([{ scenario: "absent" }, { scenario: "empty", ports: [] }])(
  "retains an internal primary without auto-publication when ports is $scenario",
  async (input) => {
    // Given
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      type: "mariadb",
      port: 3307,
      ...("ports" in input ? { ports: input.ports } : {}),
    });
    // When
    const plan = await planService(mariadbServiceType, service);
    // Then
    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 3307, protocol: "tcp", name: "server", primary: true },
    ]);
  },
);
