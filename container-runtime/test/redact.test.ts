import { beforeEach, describe, expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { Effect } from "effect";

import { redactDetails, redactString, runtimeDiagnosticContext, withApiReason } from "../src/redact.ts";

const patternRedactor = createStandaloneRedactor("secrets", { sourceEnv: {} });

let fixtureRedaction = makeRedactionService();
beforeEach(() => {
  fixtureRedaction = makeRedactionService();
});

describe("runtime-registered redaction", () => {
  test("redactString observes exact values registered after first use", () => {
    // Given
    const redactor = Effect.runSync(fixtureRedaction.forProfile("secrets"));
    redactString("initial provider check", redactor);
    Effect.runSync(fixtureRedaction.registerValues(["opaque-runtime-canary-1261"]));
    // When
    const out = redactString("engine said opaque-runtime-canary-1261; retry start", redactor);
    // Then
    expect(out).toBe("engine said [redacted]; retry start");
  });

  test("redactDetails observes exact values registered after first use", () => {
    // Given
    const redactor = Effect.runSync(fixtureRedaction.forProfile("secrets"));
    redactDetails({ evidence: ["initial provider check"] }, redactor);
    Effect.runSync(fixtureRedaction.registerValues(["opaque-runtime-canary-1261"]));
    // When
    const out = redactDetails(
      {
        evidence: ["engine said opaque-runtime-canary-1261", { detail: "opaque-runtime-canary-1261" }],
        status: 500,
      },
      redactor,
    );
    // Then
    expect(out).toEqual({ evidence: ["engine said [redacted]", { detail: "[redacted]" }], status: 500 });
  });

  test("withApiReason observes exact values registered after first use", () => {
    // Given
    const redactor = Effect.runSync(fixtureRedaction.forProfile("secrets"));
    withApiReason("Start failed.", { body: '{"message":"initial provider check"}' }, redactor);
    Effect.runSync(fixtureRedaction.registerValues(["opaque-runtime-canary-1261"]));
    // When
    const out = withApiReason(
      "Start failed.",
      {
        body: JSON.stringify({ message: "engine said opaque-runtime-canary-1261" }),
      },
      redactor,
    );
    // Then
    expect(out).toBe("Start failed. engine said [redacted]");
  });
});

describe("redactDetails", () => {
  test("masks property values whose key looks like a credential", () => {
    const out = redactDetails(
      {
        username: "alice",
        password: "hunter2",
        apiKey: "sk-123",
        api_key: "sk-456",
        Authorization: "Bearer xyz",
        noise: "ok",
      },
      patternRedactor,
    );
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
      patternRedactor,
    );
    expect(out).toBe(
      "request body: Env=[POSTGRES_PASSWORD=[redacted],REDIS_TOKEN=[redacted]] command=postgres",
    );
  });

  test("recurses into nested objects and arrays", () => {
    const out = redactDetails(
      {
        service: "database",
        env: ["POSTGRES_PASSWORD=hunter2", "POSTGRES_DB=lando"],
        nested: { secret: "shh", deep: { token: "abc" } },
      },
      patternRedactor,
    );
    expect(out).toEqual({
      service: "database",
      env: ["POSTGRES_PASSWORD=[redacted]", "POSTGRES_DB=lando"],
      nested: { secret: "[redacted]", deep: { token: "[redacted]" } },
    });
  });

  test("preserves null, undefined, and primitive values", () => {
    expect(redactDetails(null, patternRedactor)).toBe(null);
    expect(redactDetails(undefined, patternRedactor)).toBe(undefined);
    expect(redactDetails(42, patternRedactor)).toBe(42);
    expect(redactDetails(true, patternRedactor)).toBe(true);
    expect(redactDetails("no secret here", patternRedactor)).toBe("no secret here");
  });

  test("redacts Error messages while preserving the error name", () => {
    const error = new Error("connection refused; POSTGRES_PASSWORD=hunter2 in url");
    const out = redactDetails(error, patternRedactor);
    if (typeof out !== "object" || out === null || !("name" in out) || !("message" in out)) {
      throw new Error("Expected redacted error details");
    }
    expect(out.name).toBe("Error");
    expect(out.message).toContain("[redacted]");
    expect(out.message).not.toContain("hunter2");
  });

  test("masks percent-encoded URL userinfo in Podman request paths", () => {
    const out = redactDetails(
      {
        path: "/libpod/images/pull?reference=https%3A%2F%2Fuser%3As3cr3tPass%40registry.internal%2Fteam%2Fimg%3A1.0&pullProgress=true",
      },
      patternRedactor,
    );
    if (typeof out !== "object" || out === null || !("path" in out) || typeof out.path !== "string") {
      throw new Error("Expected redacted request path");
    }
    expect(out.path).not.toContain("s3cr3tPass");
    expect(out.path).toContain("https%3A%2F%2F[redacted]%40registry.internal");
  });
});

describe("required redactor contract", () => {
  test.each([false, true])(
    "runtime diagnostics prefer the service over a retained redactor (service=%s)",
    (withService) => {
      // Given distinct retained, registered, and environment secrets.
      const retained = createStandaloneRedactor("secrets", {
        authoritativeTokens: ["retained-secret-value"],
      });
      const service = makeRedactionService();
      Effect.runSync(service.registerValues(["registered-secret-value"]));
      const effect = runtimeDiagnosticContext({
        providerId: "fixture",
        remediation: "Repair the fixture provider.",
        env: { API_TOKEN: "environment-secret-value" },
        redactor: retained,
      });
      // When resolving diagnostics with or without the runtime service.
      const { redactor } = Effect.runSync(
        withService ? effect.pipe(Effect.provideService(RedactionService, service)) : effect,
      );
      // Then the service combines registrations and environment; the fallback keeps the retained policy.
      expect(
        redactor.redactString("retained-secret-value registered-secret-value environment-secret-value"),
      ).toBe(
        withService
          ? "retained-secret-value [redacted] [redacted]"
          : "[redacted] registered-secret-value environment-secret-value",
      );
    },
  );

  test.each([false, true])(
    "runtime diagnostics mask explicit environment values (service=%s)",
    (withService) => {
      const effect = runtimeDiagnosticContext({
        providerId: "fixture",
        remediation: "Repair the fixture provider.",
        env: { API_TOKEN: "seeded-env-secret-p5" },
      });
      const { redactor } = Effect.runSync(
        withService ? effect.pipe(Effect.provideService(RedactionService, makeRedactionService())) : effect,
      );
      expect(redactString("failure seeded-env-secret-p5", redactor)).toBe("failure [redacted]");
      expect(redactDetails({ detail: "seeded-env-secret-p5" }, redactor)).toEqual({ detail: "[redacted]" });
    },
  );
});
