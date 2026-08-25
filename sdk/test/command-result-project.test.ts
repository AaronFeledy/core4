import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { listSelectableResultKeys, projectEncodedResult } from "@lando/sdk/command-result";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const projectionFailure = (run: () => unknown): Record<string, unknown> => {
  try {
    run();
  } catch (error) {
    if (isRecord(error) && error._tag === "JsonProjectionError") return error;
    throw error;
  }
  throw new Error("expected projectEncodedResult to throw");
};

describe("listSelectableResultKeys", () => {
  test("returns struct field names when the schema has fields", () => {
    const keys = listSelectableResultKeys(
      Schema.Struct({ name: Schema.String, age: Schema.optional(Schema.Number) }),
    );

    expect(keys).toEqual(["name", "age"]);
  });

  test("returns an empty list when the schema has no fields", () => {
    expect(listSelectableResultKeys(Schema.String)).toEqual([]);
    expect(listSelectableResultKeys(Schema.Array(Schema.String))).toEqual([]);
    expect(listSelectableResultKeys(Schema.Struct({}))).toEqual([]);
  });
});

describe("projectEncodedResult", () => {
  test("picks requested keys in caller order", () => {
    const projected = projectEncodedResult({ name: "ada", age: 36, city: "london" }, ["age", "name"]);

    expect(Object.keys(projected)).toEqual(["age", "name"]);
    expect(projected).toEqual({ age: 36, name: "ada" });
  });

  test("throws unknown_key when a requested key is absent from the encoded object", () => {
    const error = projectionFailure(() => projectEncodedResult({ name: "ada", age: 36 }, ["nope"]));

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("unknown_key");
    expect(error.keys).toEqual(["nope"]);
    expect(error.available).toEqual(["name", "age"]);
    expect(typeof error.remediation).toBe("string");
  });

  test("throws duplicate_key when a requested key is repeated", () => {
    const error = projectionFailure(() => projectEncodedResult({ name: "ada" }, ["name", "name"]));

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("duplicate_key");
    expect(error.keys).toEqual(["name", "name"]);
    expect(error.available).toEqual(["name"]);
  });

  test("throws non_object_result when the encoded value is a string", () => {
    const error = projectionFailure(() => projectEncodedResult("ada", ["name"]));

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("non_object_result");
    expect(error.keys).toEqual(["name"]);
    expect(error.available).toEqual([]);
  });

  test("throws non_object_result when the encoded value is an array", () => {
    const error = projectionFailure(() => projectEncodedResult(["ada"], ["0"]));

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("non_object_result");
    expect(error.available).toEqual([]);
  });

  test("throws non_object_result when the encoded value is null", () => {
    const error = projectionFailure(() => projectEncodedResult(null, ["name"]));

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("non_object_result");
  });
});
