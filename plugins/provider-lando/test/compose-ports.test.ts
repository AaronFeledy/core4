import { describe, expect, test } from "bun:test";

import { DateTime } from "effect";

import { renderCompose } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type EndpointPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-21T00:00:00Z"),
  source: "compose-ports.test",
  runtime: 4 as const,
};

const renderPorts = (endpoints: ReadonlyArray<EndpointPlan>): string => {
  const service: ServicePlan = {
    name: serviceName,
    type: "web",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints,
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  const plan: AppPlan = {
    id: AppId.make("ports-test"),
    name: "Ports Test",
    slug: "ports-test",
    root: AbsolutePath.make("/srv/ports-test"),
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    networks: [],
    stores: [],
    metadata,
    extensions: {},
  };

  return renderCompose(plan);
};

describe("provider-lando Compose port rendering", () => {
  test("renders the bundled proxy HTTP and HTTPS loopback publications", () => {
    // Given
    const endpoints: ReadonlyArray<EndpointPlan> = [
      { port: 80, protocol: "http", name: "web", bind: "127.0.0.1", publishedPort: 38080 },
      { port: 443, protocol: "https", name: "websecure", bind: "127.0.0.1", publishedPort: 38443 },
    ];

    // When
    const content = renderPorts(endpoints);

    // Then
    expect(content).toContain('      - "127.0.0.1:38080:80"\n');
    expect(content).toContain('      - "127.0.0.1:38443:443"\n');
  });

  test("renders an explicitly bound published endpoint", () => {
    const content = renderPorts([
      { port: 80, protocol: "http", name: "http", bind: "127.0.0.1", publishedPort: 38080 },
    ]);

    expect(content).toContain('      - "127.0.0.1:38080:80"\n');
  });

  test("renders a published endpoint without a bind for the managed loopback default", () => {
    const content = renderPorts([{ port: 80, protocol: "http", name: "http", publishedPort: 38080 }]);

    expect(content).toContain('      - "38080:80"\n');
  });

  test("renders a bind-only endpoint with its target port", () => {
    const content = renderPorts([{ port: 8080, protocol: "tcp", name: "http", bind: "0.0.0.0" }]);

    expect(content).toContain('      - "0.0.0.0:8080:8080"\n');
    expect(content).not.toContain("    expose:\n");
  });

  test("renders an HTTPS target with its planned published port", () => {
    const content = renderPorts([{ port: 443, protocol: "https", name: "https", publishedPort: 38443 }]);

    expect(content).toContain('      - "38443:443"\n');
  });

  test("preserves the UDP suffix on a published endpoint", () => {
    const content = renderPorts([{ port: 53, protocol: "udp", name: "dns", publishedPort: 38053 }]);

    expect(content).toContain('      - "38053:53/udp"\n');
  });

  test("exposes a target-only endpoint without publishing an identity mapping", () => {
    const content = renderPorts([{ port: 3000, protocol: "http", name: "http" }]);

    expect(content).toContain('    expose:\n      - "3000"\n');
    expect(content).not.toContain("    ports:\n");
    expect(content).not.toContain('      - "3000:3000"\n');
  });

  test("preserves the UDP suffix on a target-only endpoint", () => {
    const content = renderPorts([{ port: 53, protocol: "udp", name: "dns" }]);

    expect(content).toContain('    expose:\n      - "53/udp"\n');
    expect(content).not.toContain('      - "53:53/udp"\n');
  });

  test("does not expose or publish a unix endpoint", () => {
    const content = renderPorts([{ protocol: "unix", name: "socket" }]);

    expect(content).not.toContain("    expose:\n");
    expect(content).not.toContain("    ports:\n");
  });
});
