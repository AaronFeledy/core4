import { describe, expect, test } from "bun:test";
/// <reference types="bun" />

import { Either, Schema } from "effect";

import {
  DEFAULT_PROXY_HTTPS_PORT,
  DEFAULT_PROXY_HTTP_PORT,
  EndpointInput,
  EndpointPlan,
  RoutePlan,
} from "@lando/sdk/schema";

const VALID_PORTS: [1, 65535] = [1, 65535];
const INVALID_PORTS: [0, 65536] = [0, 65536];

test("exports fixed Beta-1 proxy authority defaults", () => {
  expect(DEFAULT_PROXY_HTTP_PORT).toBe(38080);
  expect(DEFAULT_PROXY_HTTPS_PORT).toBe(38443);
});

describe("published endpoint bindings", () => {
  test.each(VALID_PORTS)("accepts container target boundary port %i at the input boundary", (port) => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({ protocol: "http", port });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each(VALID_PORTS)("accepts container target boundary port %i at the plan boundary", (port) => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({ protocol: "http", port });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each(INVALID_PORTS)("rejects container target boundary port %i at the input boundary", (port) => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({ protocol: "http", port });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test.each(INVALID_PORTS)("rejects container target boundary port %i at the plan boundary", (port) => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({ protocol: "http", port });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test.each(VALID_PORTS)("accepts published boundary port %i at the input boundary", (publishedPort) => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({
      protocol: "http",
      port: 8080,
      publishedPort,
    });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each(VALID_PORTS)("accepts published boundary port %i at the plan boundary", (publishedPort) => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({ protocol: "http", port: 8080, publishedPort });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each(INVALID_PORTS)("rejects published boundary port %i at the input boundary", (publishedPort) => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({
      protocol: "http",
      port: 8080,
      publishedPort,
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test.each(INVALID_PORTS)("rejects published boundary port %i at the plan boundary", (publishedPort) => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({ protocol: "http", port: 8080, publishedPort });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("accepts omitted publication at the input boundary", () => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({ protocol: "http", port: 8080 });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test("accepts omitted publication at the plan boundary", () => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({ protocol: "http", port: 8080 });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test("rejects bind without a container target at the input boundary", () => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({ protocol: "http", bind: "127.0.0.1" });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects bind without a container target at the plan boundary", () => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({ protocol: "http", bind: "127.0.0.1" });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects bind for unix endpoint input", () => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({
      protocol: "unix",
      socketPath: "/run/app.sock",
      bind: "127.0.0.1",
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects bind for unix endpoint plans", () => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({
      protocol: "unix",
      socketPath: "/run/app.sock",
      bind: "127.0.0.1",
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects published ports for unix endpoint plans", () => {
    const decoded = Schema.decodeUnknownEither(EndpointPlan)({
      protocol: "unix",
      socketPath: "/run/app.sock",
      publishedPort: 38080,
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects published ports for unix endpoint input", () => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({
      protocol: "unix",
      socketPath: "/run/app.sock",
      publishedPort: 38080,
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("round-trips separate container and host ports at the plan boundary", () => {
    // Given
    const encoded: typeof EndpointPlan.Encoded = {
      protocol: "http",
      port: 8080,
      bind: "127.0.0.1",
      publishedPort: 38080,
    };

    // When
    const decoded = Schema.decodeUnknownSync(EndpointPlan)(encoded, { onExcessProperty: "error" });
    const roundTrip = Schema.encodeSync(EndpointPlan)(decoded);

    // Then
    expect(roundTrip).toEqual(encoded);
  });

  test("round-trips publication fields at the endpoint input boundary", () => {
    // Given
    const encoded: typeof EndpointInput.Encoded = {
      protocol: "https",
      port: 8443,
      bind: "127.0.0.1",
      publishedPort: 38443,
    };

    // When
    const decoded = Schema.decodeUnknownSync(EndpointInput)(encoded, { onExcessProperty: "error" });
    const roundTrip = Schema.encodeSync(EndpointInput)(decoded);

    // Then
    expect(roundTrip).toEqual(encoded);
  });

  test("rejects a published port without a container target port", () => {
    // Given
    const encoded = { protocol: "http", publishedPort: 38080 };

    // When
    const decoded = Schema.decodeUnknownEither(EndpointPlan)(encoded, { onExcessProperty: "error" });

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects a published port without a container target at the input boundary", () => {
    const decoded = Schema.decodeUnknownEither(EndpointInput)({ protocol: "http", publishedPort: 38080 });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects publication fields for unix endpoints", () => {
    // Given
    const encoded = { protocol: "unix", socketPath: "/run/app.sock", port: 8080, publishedPort: 38080 };

    // When
    const decoded = Schema.decodeUnknownEither(EndpointInput)(encoded, { onExcessProperty: "error" });

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("resolved route authority", () => {
  test.each(VALID_PORTS)("accepts HTTP authority boundary port %i", (http) => {
    const decoded = Schema.decodeUnknownEither(RoutePlan)({
      hostname: "app.lndo.site",
      scheme: "http",
      service: "web",
      authorityPorts: { http },
    });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each(VALID_PORTS)("accepts HTTPS authority boundary port %i", (https) => {
    const decoded = Schema.decodeUnknownEither(RoutePlan)({
      hostname: "app.lndo.site",
      scheme: "https",
      service: "web",
      authorityPorts: { https },
    });

    expect(Either.isRight(decoded)).toBe(true);
  });

  test.each(INVALID_PORTS)("rejects HTTP authority boundary port %i", (http) => {
    const decoded = Schema.decodeUnknownEither(RoutePlan)({
      hostname: "app.lndo.site",
      scheme: "http",
      service: "web",
      authorityPorts: { http },
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test.each(INVALID_PORTS)("rejects HTTPS authority boundary port %i", (https) => {
    const decoded = Schema.decodeUnknownEither(RoutePlan)({
      hostname: "app.lndo.site",
      scheme: "https",
      service: "web",
      authorityPorts: { https },
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("round-trips nested HTTP and HTTPS authority ports", () => {
    // Given
    const encoded: typeof RoutePlan.Encoded = {
      hostname: "app.lndo.site",
      scheme: "both",
      service: "web",
      authorityPorts: { http: 38080, https: 38443 },
    };

    // When
    const decoded = Schema.decodeUnknownSync(RoutePlan)(encoded, { onExcessProperty: "error" });
    const roundTrip = Schema.encodeSync(RoutePlan)(decoded);

    // Then
    expect(roundTrip).toEqual(encoded);
  });

  test("rejects authority ports outside the TCP port range", () => {
    // Given
    const encoded = {
      hostname: "app.lndo.site",
      scheme: "http",
      service: "web",
      authorityPorts: { http: 65536 },
    };

    // When
    const decoded = Schema.decodeUnknownEither(RoutePlan)(encoded, { onExcessProperty: "error" });

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });
});
