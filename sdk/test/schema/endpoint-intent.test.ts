import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { BindAddress, EndpointInput, EndpointPlan, PortNumber, RoutePlan } from "@lando/sdk/schema";

const decodeInput = Schema.decodeUnknownResult(EndpointInput, { onExcessProperty: "error" });
const decodePlan = Schema.decodeUnknownResult(EndpointPlan, { onExcessProperty: "error" });

describe("endpoint publication intent", () => {
  test("represents publish-with-defaults explicitly", () => {
    const result = decodeInput({
      _tag: "published",
      protocol: "http",
      port: 8080,
      publication: {},
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test.each(["tcp", "udp"] as const)("accepts published %s endpoints", (protocol) => {
    const result = decodePlan({
      _tag: "published",
      protocol,
      port: 53,
      publication: { bindAddress: "127.0.0.1", hostPort: 5353 },
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("preserves optional application protocol metadata", () => {
    // Given / When
    const result = decodePlan({
      _tag: "published",
      protocol: "tcp",
      port: 8080,
      appProtocol: "http/1.1",
      publication: {},
    });

    // Then
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success._tag).toBe("published");
      if (result.success._tag === "published") expect(result.success.appProtocol).toBe("http/1.1");
    }
  });

  test("rejects application protocol metadata on internal endpoints", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(EndpointInput)(
      { _tag: "internal", protocol: "tcp", port: 8080, appProtocol: "http/1.1" },
      { onExcessProperty: "error" },
    );

    // Then
    expect(Result.isFailure(result)).toBe(true);
  });

  test("accepts internal unix endpoints", () => {
    const result = decodeInput({
      _tag: "internal",
      protocol: "unix",
      socketPath: "/run/app.sock",
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("rejects publication on unix endpoints", () => {
    const result = decodeInput({
      _tag: "published",
      protocol: "unix",
      socketPath: "/run/app.sock",
      publication: {},
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  test.each(["localhost", "999.1.1.1", "127.0.0.1:8080", ""])(
    "rejects invalid bind address %p",
    (bindAddress) => {
      expect(Result.isFailure(Schema.decodeUnknownResult(BindAddress)(bindAddress))).toBe(true);
    },
  );

  test.each([1, 65535])("accepts boundary port %i", (port) => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(PortNumber)(port))).toBe(true);
  });

  test.each([0, 65536, 1.5])("rejects invalid port %p", (port) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PortNumber)(port))).toBe(true);
  });
});

test("route plans require a resolved HTTP backend", () => {
  const result = Schema.decodeUnknownResult(RoutePlan, { onExcessProperty: "error" })({
    hostname: "app.lndo.site",
    scheme: "https",
    service: "web",
    backend: { service: "web", protocol: "http", port: 8080 },
  });

  expect(Result.isSuccess(result)).toBe(true);
});

test("route plans accept an optional cross-engine backend host", () => {
  const result = Schema.decodeUnknownResult(RoutePlan, { onExcessProperty: "error" })({
    hostname: "web.shop.lndo.site",
    scheme: "https",
    service: "web",
    backend: { service: "web", protocol: "http", port: 32768, host: "host.lando.internal" },
  });

  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success.backend.host).toBe("host.lando.internal");
    expect(result.success.backend.port).toBe(32768);
  }
});
