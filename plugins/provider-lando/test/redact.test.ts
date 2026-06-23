import { describe, expect, test } from "bun:test";

import { redactDetails } from "../src/redact.ts";

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
    const out = redactDetails(error) as { name: string; message: string };
    expect(out.name).toBe("Error");
    expect(out.message).toContain("[redacted]");
    expect(out.message).not.toContain("hunter2");
  });
});
