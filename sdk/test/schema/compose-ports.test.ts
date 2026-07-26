import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ComposeExposeField, ComposePortsField } from "../../src/schema/compose-ports.ts";

const decodePorts = (input: unknown) =>
  Schema.decodeUnknownSync(ComposePortsField)(input, { onExcessProperty: "error" });

const decodeExpose = (input: unknown) => Schema.decodeUnknownSync(ComposeExposeField)(input);

const idempotentPortInputs: ReadonlyArray<readonly [label: string, input: unknown]> = [
  [
    "long form",
    [
      {
        target: 80,
        published: "8080",
        host_ip: "127.0.0.1",
        protocol: "udp",
        name: "web",
        app_protocol: "http",
      },
    ],
  ],
  ["scalar host mapping", ["8080:80"]],
  ["IPv4 UDP mapping", ["127.0.0.1:8080:80/udp"]],
  ["container-only port", ["80"]],
  ["IPv6 mapping", ["[::1]:8080:80"]],
  ["dynamic host port", ["127.0.0.1::80"]],
  ["container-only range", ["3000-3005"]],
  ["equal-length ranges", ["9090-9091:8080-8081"]],
  ["numeric published port", [{ target: 80, published: 8080 }]],
  ["string published port", [{ target: 80, published: "8080" }]],
  ["multiple entries", ["127.0.0.1:8080:80/udp", "3000"]],
];

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

  test.each([
    ["exponent target", "1e3"],
    ["hex target", "0x50"],
    ["float target", "80.0"],
    ["positive signed target", "+80"],
    ["negative signed target", "-80"],
    ["whitespace-padded target", " 80 "],
    ["empty target", ""],
    ["exponent published port", "1e3:80"],
    ["hex published port", "0x50:80"],
    ["float published port", "80.0:80"],
    ["signed published port", "+80:80"],
    ["whitespace-padded published port", " 80 :80"],
    ["exponent range bound", "80-8e1"],
    ["empty range bound", "80-"],
  ])("rejects a non-decimal %s token", (_label, entry) => {
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

  test("rejects the unsupported long-form mode key under default and strict decoding", () => {
    // Given
    const input = [{ target: 80, mode: "host" }];

    // When
    const defaultResult = Schema.decodeUnknownEither(ComposePortsField)(input);
    const strictResult = Schema.decodeUnknownEither(ComposePortsField)(input, { onExcessProperty: "error" });

    // Then
    for (const result of [defaultResult, strictResult]) {
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(String(result.left)).toContain("[0]");
        expect(String(result.left)).toContain("mode");
      }
    }
  });

  test("rejects an exponent long-form published token at its array index", () => {
    // Given / When / Then
    expectPortFailure({ target: 80, published: "1e3" });
  });

  test("canonicalizes numeric and string published ports identically", () => {
    // Given
    const numeric = [{ target: 80, published: 8080 }];
    const string = [{ target: 80, published: "8080" }];

    // When / Then
    expect(decodePorts(numeric)).toEqual(decodePorts(string));
  });

  test.each(idempotentPortInputs)("is idempotent for %s", (_label, input) => {
    // Given
    const decoded = decodePorts(input);

    // When
    const decodedAgain = decodePorts(decoded);

    // Then
    expect(decodedAgain).toEqual(decoded);
    expect(Schema.decodeUnknownSync(ComposePortsField)(decoded)).toEqual(decoded);
  });

  test("rejects a mixed Compose and canonical long-form object", () => {
    // Given
    const input = [{ target: 80, host_ip: "127.0.0.1", appProtocol: "http" }];

    // When
    const defaultResult = Schema.decodeUnknownEither(ComposePortsField)(input);
    const strictResult = Schema.decodeUnknownEither(ComposePortsField)(input, {
      onExcessProperty: "error",
    });

    // Then
    for (const result of [defaultResult, strictResult]) {
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(String(result.left)).toContain("appProtocol");
    }
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

  test("rejects an exponent container port token at its array index", () => {
    // Given
    const input = ["8e1"];

    // When
    const result = Schema.decodeUnknownEither(ComposeExposeField)(input);

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(String(result.left)).toContain("[0]");
  });
});
