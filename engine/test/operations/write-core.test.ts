import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import {
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  parseConfigPath,
  parseConfigValue,
} from "../../src/config-write/write-core.ts";

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

describe("applySetMutation", () => {
  test("sets a typed value into the encoded tree", () => {
    const result = applySetMutation({
      tree: { name: "app" },
      key: "services.web.type",
      raw: "php",
      type: "string",
      file: FILE,
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.next).toEqual({ name: "app", services: { web: { type: "php" } } });
      expect(result.success.value).toBe("php");
    }
  });

  test("propagates a path error", () => {
    const result = applySetMutation({ tree: {}, key: "", raw: "x", type: "string", file: FILE });
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("applyUnsetMutation", () => {
  test("removes a key and reports changed", () => {
    const result = applyUnsetMutation({ tree: { a: { b: 1 } }, key: "a.b", file: FILE });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.changed).toBe(true);
      expect(result.success.next).toEqual({ a: {} });
    }
  });

  test("no-op on a missing key reports changed:false", () => {
    const result = applyUnsetMutation({ tree: { a: 1 }, key: "z", file: FILE });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.changed).toBe(false);
  });
});

describe("decodeIssues", () => {
  const schema = Schema.Struct({ name: Schema.String, port: Schema.Number });
  const decode = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" });

  test("returns [] when the tree is valid", () => {
    expect(decodeIssues(decode({ name: "a", port: 1 }))).toEqual([]);
  });

  test("returns readable issue strings when invalid", () => {
    const issues = decodeIssues(decode({ name: "a", port: "x" }));
    expect(issues.length).toBeGreaterThan(0);
  });
});
