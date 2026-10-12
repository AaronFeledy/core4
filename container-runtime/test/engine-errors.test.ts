import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";

import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import {
  apiResponseFailure,
  engineApiFailure,
  missingApi,
  parseEngineJson,
  transportFailure,
} from "../src/engine-errors.ts";
import { ContainerTransportError } from "../src/transport.ts";

const ctx = { providerId: "test-provider", remediation: "Run the provider doctor." } as const;

beforeEach(resetRegisteredRedactionValuesForTesting);
afterEach(resetRegisteredRedactionValuesForTesting);

describe("container engine error mapping", () => {
  test("redacts runtime-registered values in API failure messages and details", () => {
    // Given
    const canary = "opaque-api-canary-1261";
    Effect.runSync(registerRedactionValues([canary]));
    const response = { status: 500, body: JSON.stringify({ message: `engine said ${canary}` }) };
    // When
    const error = apiResponseFailure(ctx, "start", response, "Start failed.");
    // Then
    expect(error.message).not.toContain(canary);
    expect(error.message).toBe("Start failed. engine said [redacted]");
    expect(JSON.stringify(error.details)).not.toContain(canary);
    expect(error.details).toEqual({ status: 500, body: '{"message":"engine said [redacted]"}' });
    expect(error.providerId).toBe(ctx.providerId);
    expect(error.operation).toBe("start");
  });

  test("redacts runtime-registered values in transport failure messages and details", () => {
    // Given
    const canary = "opaque-transport-canary-1261";
    Effect.runSync(registerRedactionValues([canary]));
    const cause = new ContainerTransportError({
      kind: "connect",
      operation: "transport",
      message: `Socket ${canary} unavailable.`,
      details: { status: 500, body: JSON.stringify({ message: `engine said ${canary}` }) },
    });
    // When
    const error = transportFailure(ctx, "start", cause);
    // Then
    expect(error.message).not.toContain(canary);
    expect(error.message).toBe("Socket [redacted] unavailable. engine said [redacted]");
    expect(JSON.stringify(error.details)).not.toContain(canary);
    expect(error.details).toEqual({ status: 500, body: '{"message":"engine said [redacted]"}' });
    expect(error.providerId).toBe(ctx.providerId);
    expect(error.operation).toBe("start");
    expect(error.cause).toBe(cause);
  });

  test("maps parse transport failures to internal errors", () => {
    // Given
    const cause = new ContainerTransportError({
      kind: "parse",
      operation: "transport",
      message: "Malformed response.",
      details: { body: '{"message":"token=secret"}' },
    });

    // When
    const error = transportFailure(ctx, "inspect", cause);

    // Then
    expect(error).toBeInstanceOf(ProviderInternalError);
    expect(error.message).toBe("Malformed response. token=[redacted]");
    expect(error.cause).toBe(cause);
    expect(error.providerId).toBe(ctx.providerId);
    expect(error.remediation).toBe(ctx.remediation);
  });

  test("maps connect transport failures to unavailable errors", () => {
    // Given
    const cause = new ContainerTransportError({
      kind: "connect",
      operation: "transport",
      message: "Socket unavailable.",
      details: { socket: "/tmp/podman.sock" },
    });

    // When
    const error = transportFailure(ctx, "ping", cause);

    // Then
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.details).toEqual({ socket: "/tmp/podman.sock" });
    expect(error.cause).toBe(cause);
  });

  test("passes through provider API errors", () => {
    // Given
    const cause = new ProviderUnavailableError({
      providerId: "original",
      operation: "request",
      message: "Already classified.",
    });

    // When
    const error = engineApiFailure(ctx, "inspect", { method: "GET", path: "/info" }, cause);

    // Then
    expect(error).toBe(cause);
  });

  test("maps unknown API failures to unavailable errors with request details", () => {
    // Given
    const cause = new TypeError("network broke");

    // When
    const error = engineApiFailure(ctx, "inspect", { method: "POST", path: "/containers/app/json" }, cause);

    // Then
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.message).toBe("Failed to call the container engine API.");
    expect(error.details).toEqual({ method: "POST", path: "/containers/app/json" });
    expect(error.cause).toBe(cause);
    expect(error.providerId).toBe(ctx.providerId);
    expect(error.remediation).toBe(ctx.remediation);
  });

  test("creates missing API errors from provider context", () => {
    // Given / When
    const error = missingApi(ctx, "pullArtifact", "Provider API stream client is missing.");

    // Then
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.operation).toBe("pullArtifact");
    expect(error.message).toBe("Provider API stream client is missing.");
    expect(error.providerId).toBe(ctx.providerId);
    expect(error.remediation).toBe(ctx.remediation);
  });

  test("parses an empty engine body as an empty object", () => {
    const result = Effect.runSync(parseEngineJson({ status: 204, body: "" }, ctx, "inspect"));
    expect(result).toEqual({});
  });

  test("passes valid engine JSON through", () => {
    const result = Effect.runSync(parseEngineJson({ status: 200, body: '{"ok":true}' }, ctx, "inspect"));
    expect(result).toEqual({ ok: true });
  });

  test("lets a call site override the remediation on invalid engine JSON", () => {
    const error = Effect.runSync(
      parseEngineJson({ status: 200, body: "{" }, ctx, "inspect", { remediation: "Run lando destroy." }).pipe(
        Effect.flip,
      ),
    );
    expect(error.remediation).toBe("Run lando destroy.");
  });

  test("fails invalid engine JSON as ProviderInternalError", () => {
    const error = Effect.runSync(
      parseEngineJson({ status: 200, body: "{" }, ctx, "inspect").pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ProviderInternalError);
    expect(error.operation).toBe("inspect");
    expect(error.providerId).toBe(ctx.providerId);
  });
});
