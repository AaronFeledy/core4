import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  parseConfigPath,
  parseConfigValue,
} from "../../../src/cli/config-write/write-core.ts";

const FILE = "/tmp/.lando.yml";

describe("parseConfigPath", () => {
  test("accepts a valid dot/bracket path", () => {
    const result = parseConfigPath("services.web.type", FILE);
    expect(Either.isRight(result)).toBe(true);
  });

  test("rejects an empty or malformed path with a tagged error + remediation", () => {
    const result = parseConfigPath("", FILE);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileWriteValidationError");
      expect(result.left.remediation.length).toBeGreaterThan(0);
    }
  });
});

describe("parseConfigValue", () => {
  test("parses a typed value", () => {
    const result = parseConfigValue("80", "number", FILE);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe(80);
  });

  test("maps a parse failure to a tagged write-validation error", () => {
    const result = parseConfigValue("nope", "number", FILE);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileWriteValidationError");
      expect(result.left.remediation.length).toBeGreaterThan(0);
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
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.next).toEqual({ name: "app", services: { web: { type: "php" } } });
      expect(result.right.value).toBe("php");
    }
  });

  test("propagates a path error", () => {
    const result = applySetMutation({ tree: {}, key: "", raw: "x", type: "string", file: FILE });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("applyUnsetMutation", () => {
  test("removes a key and reports changed", () => {
    const result = applyUnsetMutation({ tree: { a: { b: 1 } }, key: "a.b", file: FILE });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.changed).toBe(true);
      expect(result.right.next).toEqual({ a: {} });
    }
  });

  test("no-op on a missing key reports changed:false", () => {
    const result = applyUnsetMutation({ tree: { a: 1 }, key: "z", file: FILE });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right.changed).toBe(false);
  });
});

describe("decodeIssues", () => {
  const schema = Schema.Struct({ name: Schema.String, port: Schema.Number });
  const decode = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" });

  test("returns [] when the tree is valid", () => {
    expect(decodeIssues(decode({ name: "a", port: 1 }))).toEqual([]);
  });

  test("returns readable issue strings when invalid", () => {
    const issues = decodeIssues(decode({ name: "a", port: "x" }));
    expect(issues.length).toBeGreaterThan(0);
  });
});
