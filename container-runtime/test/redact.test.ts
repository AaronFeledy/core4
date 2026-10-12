import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerRedactionValues, resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";
import { Effect } from "effect";

import { redactDetails, redactString, withApiReason } from "../src/redact.ts";

beforeEach(resetRegisteredRedactionValuesForTesting);
afterEach(resetRegisteredRedactionValuesForTesting);

describe("runtime-registered redaction", () => {
  test("redactString observes exact values registered after first use", () => {
    // Given
    redactString("initial provider check");
    Effect.runSync(registerRedactionValues(["opaque-runtime-canary-1261"]));
    // When
    const out = redactString("engine said opaque-runtime-canary-1261; retry start");
    // Then
    expect(out).toBe("engine said [redacted]; retry start");
  });

  test("redactDetails observes exact values registered after first use", () => {
    // Given
    redactDetails({ evidence: ["initial provider check"] });
    Effect.runSync(registerRedactionValues(["opaque-runtime-canary-1261"]));
    // When
    const out = redactDetails({
      evidence: ["engine said opaque-runtime-canary-1261", { detail: "opaque-runtime-canary-1261" }],
      status: 500,
    });
    // Then
    expect(out).toEqual({ evidence: ["engine said [redacted]", { detail: "[redacted]" }], status: 500 });
  });

  test("withApiReason observes exact values registered after first use", () => {
    // Given
    withApiReason("Start failed.", { body: '{"message":"initial provider check"}' });
    Effect.runSync(registerRedactionValues(["opaque-runtime-canary-1261"]));
    // When
    const out = withApiReason("Start failed.", {
      body: JSON.stringify({ message: "engine said opaque-runtime-canary-1261" }),
    });
    // Then
    expect(out).toBe("Start failed. engine said [redacted]");
  });
});

describe("redactDetails", () => {
  test("masks property values whose key looks like a credential", () => {
    const out = redactDetails({
      username: "alice",
      password: "hunter2",
      apiKey: "sk-123",
      api_key: "sk-456",
      Authorization: "Bearer xyz",
      noise: "ok",
    });
    expect(out).toEqual({
      username: "alice",
      password: "[redacted]",
      apiKey: "[redacted]",
      api_key: "[redacted]",
      Authorization: "[redacted]",
      noise: "ok",
    });
  });

  test("masks env-style NAME=value substrings inside string bodies", () => {
    const out = redactDetails(
      "request body: Env=[POSTGRES_PASSWORD=hunter2,REDIS_TOKEN=abc] command=postgres",
    );
    expect(out).toBe(
      "request body: Env=[POSTGRES_PASSWORD=[redacted],REDIS_TOKEN=[redacted]] command=postgres",
    );
  });

  test("recurses into nested objects and arrays", () => {
    const out = redactDetails({
      service: "database",
      env: ["POSTGRES_PASSWORD=hunter2", "POSTGRES_DB=lando"],
      nested: { secret: "shh", deep: { token: "abc" } },
    });
    expect(out).toEqual({
      service: "database",
      env: ["POSTGRES_PASSWORD=[redacted]", "POSTGRES_DB=lando"],
      nested: { secret: "[redacted]", deep: { token: "[redacted]" } },
    });
  });

  test("preserves null, undefined, and primitive values", () => {
    expect(redactDetails(null)).toBe(null);
    expect(redactDetails(undefined)).toBe(undefined);
    expect(redactDetails(42)).toBe(42);
    expect(redactDetails(true)).toBe(true);
    expect(redactDetails("no secret here")).toBe("no secret here");
  });

  test("redacts Error messages while preserving the error name", () => {
    const error = new Error("connection refused; POSTGRES_PASSWORD=hunter2 in url");
    const out = redactDetails(error);
    if (typeof out !== "object" || out === null || !("name" in out) || !("message" in out)) {
      throw new Error("Expected redacted error details");
    }
    expect(out.name).toBe("Error");
    expect(out.message).toContain("[redacted]");
    expect(out.message).not.toContain("hunter2");
  });

  test("masks percent-encoded URL userinfo in Podman request paths", () => {
    const out = redactDetails({
      path: "/libpod/images/pull?reference=https%3A%2F%2Fuser%3As3cr3tPass%40registry.internal%2Fteam%2Fimg%3A1.0&pullProgress=true",
    });
    if (typeof out !== "object" || out === null || !("path" in out) || typeof out.path !== "string") {
      throw new Error("Expected redacted request path");
    }
    expect(out.path).not.toContain("s3cr3tPass");
    expect(out.path).toContain("https%3A%2F%2F[redacted]%40registry.internal");
  });
});
