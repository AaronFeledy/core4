import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { BindAddress, EndpointInput, EndpointPlan, PortNumber, RoutePlan } from "@lando/sdk/schema";

const decodeInput = Schema.decodeUnknownEither(EndpointInput, { onExcessProperty: "error" });
const decodePlan = Schema.decodeUnknownEither(EndpointPlan, { onExcessProperty: "error" });

describe("endpoint publication intent", () => {
  test("represents publish-with-defaults explicitly", () => {
    const result = decodeInput({
      _tag: "published",
      protocol: "http",
      port: 8080,
      publication: {},
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test.each(["tcp", "udp"] as const)("accepts published %s endpoints", (protocol) => {
    const result = decodePlan({
      _tag: "published",
      protocol,
      port: 53,
      publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("accepts internal unix endpoints", () => {
    const result = decodeInput({
      _tag: "internal",
      protocol: "unix",
      socketPath: "/run/app.sock",
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("rejects publication on unix endpoints", () => {
    const result = decodeInput({
      _tag: "published",
      protocol: "unix",
      socketPath: "/run/app.sock",
      publication: {},
    });

    expect(Either.isLeft(result)).toBe(true);
  });

  test.each(["localhost", "999.1.1.1", "127.0.0.1:8080", ""])(
    "rejects invalid bind address %p",
    (bindAddress) => {
      expect(Either.isLeft(Schema.decodeUnknownEither(BindAddress)(bindAddress))).toBe(true);
    },
  );

  test.each([1, 65535])("accepts boundary port %i", (port) => {
    expect(Either.isRight(Schema.decodeUnknownEither(PortNumber)(port))).toBe(true);
  });

  test.each([0, 65536, 1.5])("rejects invalid port %p", (port) => {
    expect(Either.isLeft(Schema.decodeUnknownEither(PortNumber)(port))).toBe(true);
  });
});

test("route plans require a resolved HTTP backend", () => {
  const result = Schema.decodeUnknownEither(RoutePlan, { onExcessProperty: "error" })({
    hostname: "app.lndo.site",
    scheme: "https",
    service: "web",
    backend: { service: "web", protocol: "http", port: 8080 },
  });

  expect(Either.isRight(result)).toBe(true);
});
