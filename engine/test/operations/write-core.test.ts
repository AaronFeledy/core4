import { describe, expect, test } from "bun:test";
import { Result } from "effect";

import { setAtPath, unsetAtPath } from "../../src/config-write/dot-path.ts";
import { parseConfigPath, parseConfigValue } from "../../src/config-write/write-core.ts";

const FILE = "/tmp/.lando.yml";

describe("parseConfigPath", () => {
  test("accepts a valid dot/bracket path", () => {
    const result = parseConfigPath("services.web.type", FILE);
    expect(Result.isSuccess(result)).toBe(true);
  });

  test("rejects an empty or malformed path with a tagged error + remediation", () => {
    const result = parseConfigPath("", FILE);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("LandofileWriteValidationError");
      expect(result.failure.remediation.length).toBeGreaterThan(0);
    }
  });
});

describe("parseConfigValue", () => {
  test("parses a typed value", () => {
    const result = parseConfigValue("80", "number", FILE);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success).toBe(80);
  });

  test("maps a parse failure to a tagged write-validation error", () => {
    const result = parseConfigValue("nope", "number", FILE);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("LandofileWriteValidationError");
      expect(result.failure.remediation.length).toBeGreaterThan(0);
    }
  });
});

describe("setAtPath", () => {
  test("sets a typed value into the encoded tree", () => {
    expect(setAtPath({ name: "app" }, ["services", "web", "type"], "php")).toEqual({
      name: "app",
      services: { web: { type: "php" } },
    });
  });

  test("propagates a path error", () => {
    const result = parseConfigPath("services..web", FILE);
    expect(result).toMatchObject({
      failure: { _tag: "LandofileWriteValidationError", path: "services..web" },
    });
  });
});

describe("unsetAtPath", () => {
  test("removes a key and reports changed", () => {
    expect(unsetAtPath({ a: { b: 1 } }, ["a", "b"])).toEqual({ changed: true, next: { a: {} } });
  });

  test("no-op on a missing key reports changed:false", () => {
    expect(unsetAtPath({ a: 1 }, ["z"])).toEqual({ changed: false, next: { a: 1 } });
  });
});
