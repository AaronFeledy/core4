import { describe, expect, test } from "bun:test";
import { publicationObservationFromInspect } from "../src/podman/inspect.ts";

describe("publicationObservationFromInspect", () => {
  test("retains daemon all-interface bindings alongside specific addresses", () => {
    const inspected = {
      NetworkSettings: {
        Ports: {
          "80/tcp": [
            { HostIp: "", HostPort: "8080" },
            { HostIp: "127.0.0.1", HostPort: "8081" },
          ],
        },
      },
    };
    expect(publicationObservationFromInspect(inspected)).toEqual({
      status: "present",
      bindings: [
        { port: 80, transport: "tcp", bindAddress: "0.0.0.0", hostPort: 8080 },
        { port: 80, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8081 },
      ],
    });
  });

  test.each([
    undefined,
    null,
    {},
    { NetworkSettings: {} },
    { NetworkSettings: { Ports: null } },
    { NetworkSettings: { Ports: [] } },
    { NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "12junk" }] } } },
    { NetworkSettings: { Ports: { "80/tcp": [{ HostPort: "8080" }] } } },
    { NetworkSettings: { Ports: { "80/invalid": [] } } },
  ])("keeps unreadable or malformed evidence unknown: %j", (inspected) => {
    // Given unreadable binding evidence. When parsed. Then absence is not invented.
    expect(publicationObservationFromInspect(inspected)).toEqual({ status: "unknown" });
  });

  test.each([{}, { "80/tcp": null }, { "80/tcp": [] }])("reports valid empty evidence: %j", (Ports) => {
    // Given a readable port table. When parsed. Then empty is known.
    expect(publicationObservationFromInspect({ NetworkSettings: { Ports } })).toEqual({
      status: "present",
      bindings: [],
    });
  });

  test("preserves actual dynamic, IPv4, IPv6 and UDP bindings without plan metadata", () => {
    // Given distinct actual bindings and unrelated sensitive metadata.
    const inspected = {
      Config: { Env: ["PASSWORD=secret"] },
      NetworkSettings: {
        Ports: {
          "443/tcp": [
            { HostIp: "127.0.0.1", HostPort: "32768" },
            { HostIp: "::", HostPort: "8443" },
          ],
          "443/udp": [{ HostIp: "0.0.0.0", HostPort: "8443" }],
        },
      },
    };
    // When
    const result = publicationObservationFromInspect(inspected);
    // Then
    expect(result).toEqual({
      status: "present",
      bindings: [
        { port: 443, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 32768 },
        { port: 443, transport: "tcp", bindAddress: "::", hostPort: 8443 },
        { port: 443, transport: "udp", bindAddress: "0.0.0.0", hostPort: 8443 },
      ],
    });
  });
});
