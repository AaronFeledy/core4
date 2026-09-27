import { describe, expect, test } from "bun:test";
import type { EndpointPlan } from "@lando/sdk/schema";
import { publishedEndpointsFromInspect } from "../src/podman/inspect.ts";

describe("publishedEndpointsFromInspect", () => {
  test.each(["tcp", "https", "http", "udp"] as const)(
    "preserves planned %s metadata when materializing a published binding",
    (protocol) => {
      // Given
      const planned = {
        _tag: "published",
        protocol,
        port: 443,
        name: "listener",
        appProtocol: "custom",
        publication: {},
      } as const;
      const transport = protocol === "udp" ? "udp" : "tcp";
      const inspected = {
        NetworkSettings: { Ports: { [`443/${transport}`]: [{ HostIp: "127.0.0.1", HostPort: "8443" }] } },
      };

      // When
      const endpoints = publishedEndpointsFromInspect(inspected, [planned]);

      // Then
      expect(endpoints).toEqual([
        { ...planned, materialization: { bindAddress: "127.0.0.1", hostPort: 8443 } },
      ]);
      expect(planned.publication).toEqual({});
    },
  );

  test("matches published endpoints by container port and transport", () => {
    // Given
    const planned = [
      { _tag: "internal", protocol: "http", port: 443, name: "internal" },
      { _tag: "published", protocol: "http", port: 80, publication: {}, name: "web" },
      { _tag: "published", protocol: "udp", port: 443, publication: {}, name: "datagram" },
      { _tag: "published", protocol: "https", port: 443, publication: {}, name: "websecure" },
    ] as const satisfies readonly EndpointPlan[];
    const inspected = {
      NetworkSettings: { Ports: { "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "8443" }] } },
    };

    // When
    const endpoints = publishedEndpointsFromInspect(inspected, planned);

    // Then
    expect(endpoints).toEqual([
      { ...planned[3], materialization: { bindAddress: "0.0.0.0", hostPort: 8443 } },
    ]);
  });

  test.each(["tcp", "udp"] as const)("keeps unplanned %s bindings as raw transport", (protocol) => {
    // Given
    const inspected = {
      NetworkSettings: { Ports: { [`6379/${protocol}`]: [{ HostIp: "127.0.0.1", HostPort: "16379" }] } },
    };

    // When
    const endpoints = publishedEndpointsFromInspect(inspected);

    // Then
    expect(endpoints).toEqual([
      {
        _tag: "published",
        protocol,
        port: 6379,
        name: `6379/${protocol}`,
        publication: { bindAddress: "127.0.0.1", hostPort: 16379 },
      },
    ]);
  });
});
