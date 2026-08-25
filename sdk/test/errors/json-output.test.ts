import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { JqExpressionError, JsonJqConflictError, JsonProjectionError } from "@lando/sdk/errors";

const projectionReasons = ["unknown_key", "duplicate_key", "non_object_result", "format_conflict"] as const;
const jqReasons = ["eval", "timeout", "too_large", "missing_value"] as const;

describe("JsonProjectionError", () => {
  test("constructs with remediation when required fields are present", () => {
    const error = new JsonProjectionError({
      message: "Unknown projection key.",
      command: "app:info",
      keys: ["name", "missing"],
      available: ["name", "urls"],
      reason: "unknown_key",
      remediation: "Pass a key from the command result.",
    });

    expect(error._tag).toBe("JsonProjectionError");
    expect(Schema.is(JsonProjectionError)(error)).toBe(true);
    expect(error.command).toBe("app:info");
    expect(error.keys).toEqual(["name", "missing"]);
    expect(error.available).toEqual(["name", "urls"]);
    expect(error.reason).toBe("unknown_key");
    expect(error.remediation).toBe("Pass a key from the command result.");
  });

  test("accepts each projection reason and omits optional command", () => {
    for (const reason of projectionReasons) {
      const error = new JsonProjectionError({
        message: `Projection failed: ${reason}.`,
        keys: ["name"],
        available: ["name"],
        reason,
        remediation: "Adjust --json keys.",
      });
      expect(error.reason).toBe(reason);
      expect(error.command).toBeUndefined();
      expect(Schema.is(JsonProjectionError)(error)).toBe(true);
    }
  });

  test("fails schema decode when a required field is missing", () => {
    const decoded = Schema.decodeUnknownEither(JsonProjectionError)({
      _tag: "JsonProjectionError",
      message: "Unknown projection key.",
      keys: ["missing"],
      available: ["name"],
      reason: "unknown_key",
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("JsonJqConflictError", () => {
  test("constructs with remediation when required fields are present", () => {
    const error = new JsonJqConflictError({
      message: "Cannot combine --jq with bare --json.",
      remediation: "cannot use --jq with bare --json; pass --json key1,key2 or omit --json",
    });

    expect(error._tag).toBe("JsonJqConflictError");
    expect(Schema.is(JsonJqConflictError)(error)).toBe(true);
    expect(error.remediation).toBe(
      "cannot use --jq with bare --json; pass --json key1,key2 or omit --json",
    );
  });

  test("fails schema decode when a required field is missing", () => {
    const decoded = Schema.decodeUnknownEither(JsonJqConflictError)({
      _tag: "JsonJqConflictError",
      message: "Cannot combine --jq with bare --json.",
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("JqExpressionError", () => {
  test("constructs with remediation when required fields are present", () => {
    const error = new JqExpressionError({
      message: "jq expression failed.",
      expression: ".name",
      reason: "eval",
      remediation: "Fix the --jq expression.",
      detail: "expected object",
    });

    expect(error._tag).toBe("JqExpressionError");
    expect(Schema.is(JqExpressionError)(error)).toBe(true);
    expect(error.expression).toBe(".name");
    expect(error.reason).toBe("eval");
    expect(error.remediation).toBe("Fix the --jq expression.");
    expect(error.detail).toBe("expected object");
  });

  test("accepts each jq reason and omits optional detail", () => {
    for (const reason of jqReasons) {
      const error = new JqExpressionError({
        message: `jq failed: ${reason}.`,
        expression: ".",
        reason,
        remediation: "Adjust the --jq expression.",
      });
      expect(error.reason).toBe(reason);
      expect(error.detail).toBeUndefined();
      expect(Schema.is(JqExpressionError)(error)).toBe(true);
    }
  });

  test("fails schema decode when a required field is missing", () => {
    const decoded = Schema.decodeUnknownEither(JqExpressionError)({
      _tag: "JqExpressionError",
      message: "jq expression failed.",
      reason: "eval",
      remediation: "Fix the --jq expression.",
    });

    expect(Either.isLeft(decoded)).toBe(true);
  });
});
