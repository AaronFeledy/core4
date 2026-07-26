import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ComposeExposeField, ComposePortsField } from "../../src/schema/compose-ports.ts";

const decodePorts = (input: unknown) =>
  Schema.decodeUnknownSync(ComposePortsField)(input, { onExcessProperty: "error" });

const decodeExpose = (input: unknown) => Schema.decodeUnknownSync(ComposeExposeField)(input);

const expectPortFailure = (entry: unknown, expectedMessage?: string): void => {
  const result = Schema.decodeUnknownEither(ComposePortsField)([entry], {
    onExcessProperty: "error",
  });

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    const issue = String(result.left);
    expect(issue).toContain("[0]");
    if (expectedMessage !== undefined) expect(issue).toContain(expectedMessage);
  }
};

describe("ComposePortsField", () => {
  test("decodes all long-form fields to canonical camelCase fields", () => {
    // Given
    const input = [
      {
        target: 80,
        published: "8080",
        host_ip: "127.0.0.1",
        protocol: "udp",
        name: "web",
        app_protocol: "http",
      },
    ];

    // When
    const decoded = decodePorts(input);

    // Then
    expect(decoded).toEqual([
      {
        target: 80,
        published: 8080,
        hostIp: "127.0.0.1",
        protocol: "udp",
        name: "web",
        appProtocol: "http",
      },
    ]);
  });

  test("decodes a scalar host mapping", () => {
    // Given / When / Then
    expect(decodePorts(["8080:80"])).toEqual([{ target: 80, published: 8080, protocol: "tcp" }]);
  });

  test("decodes an IPv4 host mapping with UDP protocol", () => {
    // Given / When / Then
    expect(decodePorts(["127.0.0.1:8080:80/udp"])).toEqual([
      { target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "udp" },
    ]);
  });

  test("decodes a container-only port without a publication", () => {
    // Given / When / Then
    expect(decodePorts(["80"])).toEqual([{ target: 80, protocol: "tcp" }]);
  });

  test("strips brackets from an IPv6 host address", () => {
    // Given / When / Then
    expect(decodePorts(["[::1]:8080:80"])).toEqual([
      { target: 80, published: 8080, hostIp: "::1", protocol: "tcp" },
    ]);
  });

  test("decodes a dynamic host port without a publication", () => {
    // Given / When / Then
    expect(decodePorts(["127.0.0.1::80"])).toEqual([{ target: 80, hostIp: "127.0.0.1", protocol: "tcp" }]);
  });

  test.each(["80:abc", "80/sctp", ":"])("rejects invalid short grammar %s at its array index", (entry) => {
    // Given / When / Then
    expectPortFailure(entry);
  });

  test("expands a container-only range", () => {
    // Given
    const input = ["3000-3005"];

    // When
    const decoded = decodePorts(input);

    // Then
    expect(decoded).toHaveLength(6);
    expect(decoded).toEqual(
      [3000, 3001, 3002, 3003, 3004, 3005].map((target) => ({ target, protocol: "tcp" })),
    );
  });

  test("maps equal-length host and container ranges one-to-one", () => {
    // Given / When / Then
    expect(decodePorts(["9090-9091:8080-8081"])).toEqual([
      { target: 8080, published: 9090, protocol: "tcp" },
      { target: 8081, published: 9091, protocol: "tcp" },
    ]);
  });

  test("rejects unequal-length host and container ranges", () => {
    // Given / When / Then
    expectPortFailure("9090-9092:8080-8081", "lengths differ");
  });

  test("rejects a host range mapped to a scalar target with enumeration remediation", () => {
    // Given / When / Then
    expectPortFailure("8000-8010:5000", "enumerate");
  });

  test("rejects a long-form published range with enumeration remediation", () => {
    // Given / When / Then
    expectPortFailure({ target: 80, published: "8083-9000" }, "enumerate");
  });

  test("rejects the unsupported long-form mode key", () => {
    // Given
    const input = [{ target: 80, mode: "host" }];

    // When
    const result = Schema.decodeUnknownEither(ComposePortsField)(input, {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(String(result.left)).toContain("mode");
  });

  test("canonicalizes numeric and string published ports identically", () => {
    // Given
    const numeric = [{ target: 80, published: 8080 }];
    const string = [{ target: 80, published: "8080" }];

    // When / Then
    expect(decodePorts(numeric)).toEqual(decodePorts(string));
  });

  test("encodes canonical ports as lawful long objects and round-trips", () => {
    // Given
    const decoded = decodePorts(["127.0.0.1:8080:80/udp", "3000"]);

    // When
    const encoded = Schema.encodeSync(ComposePortsField)(decoded);
    const decodedAgain = decodePorts(encoded);

    // Then
    expect(encoded).toEqual([
      { target: 80, published: 8080, host_ip: "127.0.0.1", protocol: "udp" },
      { target: 3000, protocol: "tcp" },
    ]);
    expect(encoded.every((entry) => typeof entry === "object" && entry !== null)).toBe(true);
    expect(decodedAgain).toEqual(decoded);
  });
});

describe("ComposeExposeField", () => {
  test("decodes string and numeric container ports", () => {
    // Given / When / Then
    expect(decodeExpose(["3000", 3001])).toEqual([3000, 3001]);
  });

  test("expands a container port range", () => {
    // Given
    const input = ["8000-8010"];

    // When
    const decoded = decodeExpose(input);

    // Then
    expect(decoded).toHaveLength(11);
    expect(decoded).toEqual(Array.from({ length: 11 }, (_, offset) => 8000 + offset));
  });
});
