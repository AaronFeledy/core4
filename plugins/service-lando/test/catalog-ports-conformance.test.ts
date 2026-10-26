import { expect, test } from "bun:test";
import {
  ServiceConfig,
  endpointInvariantIssues,
  groupLogicalEndpoints,
  logicalEndpointIdentity,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

test.each([...serviceTypes].filter(([type]) => type !== "node"))(
  "%s normalizes publications and expose without changing declared listeners",
  async (type, serviceType) => {
    // Given
    const input = {
      type,
      home: false,
      ...(type === "compose" || type === "lando" ? { image: "alpine:3" } : {}),
      ...(type.startsWith("varnish") ? { backend: "origin" } : {}),
    };
    const compose = (service: ServiceConfig) =>
      composeServicePlan({
        serviceType,
        service,
        serviceName: "worker",
        appRoot: "/srv/app",
        metadata: { resolvedAt: "2026-10-23T00:00:00Z", source: "catalog-ports", runtime: 4 },
      });
    const baseline = await compose(Schema.decodeUnknownSync(ServiceConfig)(input));
    const listeners = groupLogicalEndpoints(baseline.endpoints);
    const ports = listeners.map((listener) => ({
      target: listener.port,
      protocol: listener.transport,
      published: listener.port,
      host_ip: "127.0.0.1",
      name: `published-${listener.port}`,
      app_protocol: "opaque/hint",
    }));
    // When
    const plan = await compose(
      Schema.decodeUnknownSync(ServiceConfig)({
        ...input,
        ports: [...ports, "19090:19090", "19090:19090/udp"],
        expose: [19091, ...listeners.map((listener) => listener.port)],
      }),
    );
    // Then
    expect(plan.endpoints.filter((endpoint) => endpoint._tag === "internal")).toEqual([
      ...baseline.endpoints.filter((endpoint) => endpoint._tag === "internal"),
      { _tag: "internal", port: 19091, protocol: "tcp" },
    ]);
    for (const listener of listeners) {
      const declaration = baseline.endpoints.find(
        (endpoint) => logicalEndpointIdentity(endpoint) === logicalEndpointIdentity(listener),
      );
      if (declaration === undefined || declaration.protocol === "unix") {
        throw new Error("Catalog network listener declaration missing");
      }
      expect(plan.endpoints).toContainEqual({
        _tag: "published",
        port: listener.port,
        protocol: declaration.protocol,
        ...(listener.primary ? { primary: true } : {}),
        name: `published-${listener.port}`,
        appProtocol: "opaque/hint",
        publication: { hostPort: listener.port, bindAddress: "127.0.0.1" },
      });
    }
    expect(plan.endpoints).toContainEqual({
      _tag: "published",
      port: 19090,
      protocol: "tcp",
      publication: { hostPort: 19090 },
    });
    expect(plan.endpoints).toContainEqual({
      _tag: "published",
      port: 19090,
      protocol: "udp",
      publication: { hostPort: 19090 },
    });
    expect(
      groupLogicalEndpoints(plan.endpoints)
        .filter((listener) => listener.primary)
        .map(logicalEndpointIdentity),
    ).toEqual(listeners.filter((listener) => listener.primary).map(logicalEndpointIdentity));
    expect(endpointInvariantIssues(plan.endpoints)).toEqual([]);
    expect(listeners.filter((listener) => listener.primary)).toHaveLength(
      type === "lando" || type === "compose" ? 0 : 1,
    );
  },
);
