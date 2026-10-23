import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
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
  });
  // When
  const plan = await planService(mariadbServiceType, service);
  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "internal", port: 3307, protocol: "tcp", name: "server" },
    { _tag: "published", port: 80, protocol: "tcp", publication: { hostPort: 8080 } },
  ]);
});

test("uses a matching publication without duplicating the primary listener", async () => {
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
    {
      _tag: "published",
      port: 3307,
      protocol: "tcp",
      publication: { bindAddress: "127.0.0.1", hostPort: 13307 },
    },
  ]);
});

test.each([nginxServiceType, node22ServiceType])(
  "$id moves the first matching publication ahead of secondary ports without losing authored metadata",
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
      {
        _tag: "published",
        port: 3187,
        protocol: "http",
        name: "primary",
        appProtocol: "http",
        publication: { bindAddress: "127.0.0.1", hostPort: 13187 },
      },
      { _tag: "published", port: 3188, protocol: "http", publication: { hostPort: 13188 } },
      { _tag: "published", port: 3187, protocol: "http", publication: { hostPort: 23187 } },
      { _tag: "published", port: 3189, protocol: "http", publication: { hostPort: 13189 } },
    ]);
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
    { _tag: "internal", port: 3307, protocol: "tcp", name: "server" },
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
    { _tag: "published", port: 3187, protocol: "http", publication: { hostPort: 23187 } },
    { _tag: "published", port: 3187, protocol: "udp", publication: { hostPort: 13187 } },
    { _tag: "published", port: 3188, protocol: "http", publication: { hostPort: 13188 } },
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
    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 3307, protocol: "tcp", name: "server" }]);
  },
);
