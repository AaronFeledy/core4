import { expect, test } from "bun:test";
import type { PublishedEndpoint } from "@lando/sdk/schema";
import { containerPortBindings } from "../src/plan.ts";
import { copyInspectHostPorts } from "../src/service-publish-ports.ts";

const fixed: PublishedEndpoint = {
  _tag: "published",
  port: 3000,
  protocol: "http",
  publication: { hostPort: 8080 },
};
const dynamic: PublishedEndpoint = { ...fixed, publication: {} };

test.each(["NetworkSettings", "HostConfig"])(
  "reserves fixed bindings before reusing dynamic aliases from %s",
  (source) => {
    // Given dynamic aliases preceding the fixed declaration and binding.
    const ports = {
      "3000/tcp": [
        { HostIp: "127.0.0.1", HostPort: "8080" },
        { HostIp: "127.0.0.1", HostPort: "30000" },
      ],
    };
    const inspected =
      source === "NetworkSettings"
        ? { NetworkSettings: { Ports: ports } }
        : { HostConfig: { PortBindings: ports } };
    // When
    const copied = copyInspectHostPorts([dynamic, { ...dynamic, name: "alias" }, fixed], inspected);
    // Then the physical create payload retains both bindings, with shared alias allocation.
    expect(copied.map((row) => (row._tag === "published" ? row.publication.hostPort : undefined))).toEqual([
      30000, 30000, 8080,
    ]);
    expect(
      containerPortBindings(copied.filter((row): row is PublishedEndpoint => row._tag === "published")),
    ).toEqual({
      "3000/tcp": [
        { HostIp: "127.0.0.1", HostPort: "30000" },
        { HostIp: "127.0.0.1", HostPort: "8080" },
      ],
    });
  },
);

test("leaves dynamic publication unassigned when inspect contains only the fixed binding", () => {
  // Given
  const inspected = {
    NetworkSettings: {
      Ports: {
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
      },
    },
  };
  // When
  const copied = copyInspectHostPorts([fixed, dynamic], inspected);
  // Then
  expect(copied).toEqual([fixed, dynamic]);
});

test("reserves bindings by listener, address and transport rather than host port alone", () => {
  // Given separate IP and UDP bindings legitimately reusing the fixed TCP host port.
  const ipv6 = { ...dynamic, publication: { bindAddress: "[::1]" } };
  const udp = { ...dynamic, protocol: "udp" as const };
  const inspected = {
    NetworkSettings: {
      Ports: {
        "3000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "8080" },
          { HostIp: "::1", HostPort: "8080" },
        ],
        "3000/udp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
      },
    },
  };
  // When
  const copied = copyInspectHostPorts([fixed, ipv6, udp], inspected);
  // Then
  expect(copied.map((row) => (row._tag === "published" ? row.publication.hostPort : undefined))).toEqual([
    8080, 8080, 8080,
  ]);
});
