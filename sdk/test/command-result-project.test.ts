import { describe, expect, test } from "bun:test";
import { Effect, Predicate, Schema } from "effect";

import {
  encodeCommandResult,
  listSelectableResultKeys,
  projectEncodedResult,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObjectOrArray(value);

const projectionFailure = (run: () => unknown): Record<string, unknown> => {
  try {
    run();
  } catch (error) {
    if (isRecord(error) && error._tag === "JsonProjectionError") return error;
    throw error;
  }
  throw new Error("expected projectEncodedResult to throw");
};

const NestedUrlsSchema = Schema.Struct({
  name: Schema.String,
  urls: Schema.Struct({
    appserver: Schema.String,
    other: Schema.String,
  }),
});

const DeepResultSchema = Schema.Struct({
  a: Schema.Struct({
    b: Schema.Struct({
      c: Schema.String,
    }),
  }),
});

const plainRedactor = createRedactor("secrets", { values: [] });
const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

const UnionResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    name: Schema.String,
    redactionTokens: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    age: Schema.Number,
    kind: Schema.Literal("age"),
    redactionTokens: Schema.Array(Schema.String),
  }),
]);
const person = { kind: "person", name: "ada", redactionTokens: ["private"] };

describe("listSelectableResultKeys", () => {
  test.each([
    ["union order, shared keys and private metadata", UnionResultSchema, ["kind", "name", "age"]],
    [
      "nested mixed union",
      Schema.Union([Schema.String, Schema.Union([UnionResultSchema, Schema.Array(Schema.String)])]),
      ["kind", "name", "age"],
    ],
    ["literal-only union", Schema.Union([Schema.Literal("a"), Schema.Literal("b")]), []],
    ["literals", Schema.Literals(["a", "b"]), []],
  ] as const)("discovers declared object keys for %s", (_name, schema, expected) => {
    // Given the declared schema; when its selectable keys are discovered.
    const keys = listSelectableResultKeys(schema);
    // Then keys follow declaration order, not the active value or internal metadata.
    expect(keys).toEqual(expected);
  });

  test("returns struct field names when the schema has fields", () => {
    const keys = listSelectableResultKeys(
      Schema.Struct({ name: Schema.String, age: Schema.optionalKey(Schema.Number) }),
    );

    expect(keys).toEqual(["name", "age"]);
  });

  test("does not offer internal redaction metadata as a result key", () => {
    const keys = listSelectableResultKeys(
      Schema.Struct({ stdout: Schema.String, redactionTokens: Schema.Array(Schema.String) }),
    );

    expect(keys).toEqual(["stdout"]);
  });

  test("returns an empty list when the schema has no fields", () => {
    expect(listSelectableResultKeys(Schema.String)).toEqual([]);
    expect(listSelectableResultKeys(Schema.Array(Schema.String))).toEqual([]);
    expect(listSelectableResultKeys(Schema.Struct({}))).toEqual([]);
  });

  test("returns only top-level field names for a nested struct schema", () => {
    expect(listSelectableResultKeys(NestedUrlsSchema)).toEqual(["name", "urls"]);
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

  test("projects a dotted path into a nested object", () => {
    const projected = projectEncodedResult({ urls: { appserver: "x", other: "y" } }, ["urls.appserver"]);

    expect(projected).toEqual({ urls: { appserver: "x" } });
  });

  test("projects a multi-segment dotted path on a deeply nested object", () => {
    const projected = projectEncodedResult({ a: { b: { c: "leaf", skip: 1 }, other: 2 } }, ["a.b.c"]);

    expect(projected).toEqual({ a: { b: { c: "leaf" } } });
  });

  test("merges dotted paths that share a parent", () => {
    const projected = projectEncodedResult({ a: { b: 1, c: 2, d: 3 } }, ["a.b", "a.c"]);

    expect(projected).toEqual({ a: { b: 1, c: 2 } });
  });

  test("throws unknown_key when a nested segment is absent", () => {
    const error = projectionFailure(() =>
      projectEncodedResult({ urls: { appserver: "x", other: "y" } }, ["urls.nope"]),
    );

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("unknown_key");
    expect(error.keys).toEqual(["urls.nope"]);
    expect(error.available).toEqual(["appserver", "other"]);
    expect(String(error.message)).toContain("urls.nope");
    expect(String(error.message)).toContain("appserver");
    expect(String(error.message)).toContain("other");
  });

  test("throws non_object_result when a dotted path walks through a non-object", () => {
    const error = projectionFailure(() => projectEncodedResult({ name: "ada" }, ["name.first"]));

    expect(error._tag).toBe("JsonProjectionError");
    expect(error.reason).toBe("non_object_result");
    expect(error.keys).toEqual(["name.first"]);
  });

  test("preserves caller order for mixed flat and dotted keys", () => {
    const projected = projectEncodedResult({ name: "ada", urls: { appserver: "x", other: "y" } }, [
      "name",
      "urls.appserver",
    ]);

    expect(Object.keys(projected)).toEqual(["name", "urls"]);
    expect(projected).toEqual({ name: "ada", urls: { appserver: "x" } });
  });
});

describe("encodeCommandResult nested projection", () => {
  test("preserves typed projection errors for a completed command failure", () => {
    const outcome = resolveCommandCompletion("app:exec", { name: "ada" }, () => ({ ok: false, exitCode: 7 }));
    const error = Effect.runSync(
      encodeCommandResult({
        command: "app:exec",
        resultSchema: Schema.Struct({ name: Schema.String }),
        outcome,
        redactor: plainRedactor,
        projectResultKeys: ["missing"],
      }).pipe(Effect.catch((error) => Effect.succeed(error))),
    );
    expect(error).toMatchObject({
      _tag: "JsonProjectionError",
      reason: "unknown_key",
      keys: ["missing"],
      available: ["name"],
    });
  });

  test("projects urls.appserver inside the success envelope", () => {
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:info",
        resultSchema: NestedUrlsSchema,
        outcome: {
          _tag: "success",
          value: { name: "ada", urls: { appserver: "x", other: "y" } },
        },
        redactor: plainRedactor,
        projectResultKeys: ["urls.appserver"],
      }),
    );

    const envelope = decodeEnvelope(line);
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toEqual({ urls: { appserver: "x" } });
  });

  test("projects a multi-segment path inside the success envelope", () => {
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:info",
        resultSchema: DeepResultSchema,
        outcome: { _tag: "success", value: { a: { b: { c: "leaf" } } } },
        redactor: plainRedactor,
        projectResultKeys: ["a.b.c"],
      }),
    );

    expect(decodeEnvelope(line).result).toEqual({ a: { b: { c: "leaf" } } });
  });
});

describe("encodeCommandResult union projection", () => {
  test.each([{ keys: ["name"] }, { keys: ["name", "age"] }])(
    "projects present fields and omits absent declared fields for %j",
    ({ keys }) => {
      // Given a person member with no age field.
      const value = person;
      // When projection uses the real encoder.
      const line = Effect.runSync(
        encodeCommandResult({
          command: "app:info",
          resultSchema: UnionResultSchema,
          outcome: { _tag: "success", value },
          redactor: plainRedactor,
          projectResultKeys: keys,
        }),
      );
      // Then only the present requested public field is emitted.
      const envelope = decodeEnvelope(line);
      expect(envelope.ok).toBe(true);
      expect(envelope.result).toEqual({ name: "ada" });
    },
  );

  test.each([
    [["nope"], person, "unknown_key"],
    [["redactionTokens"], person, "unknown_key"],
    [["name", "name"], person, "duplicate_key"],
    [["name"], "ada", "non_object_result"],
  ] as const)("preserves projection errors for keys %j", (keys, value, reason) => {
    // Given a union admitting both object and scalar results.
    const resultSchema = Schema.Union([UnionResultSchema, Schema.String]);
    // When the encoder attempts an invalid projection, capture its typed failure.
    const error = Effect.runSync(
      encodeCommandResult({
        command: "app:info",
        resultSchema,
        outcome: { _tag: "success", value },
        redactor: plainRedactor,
        projectResultKeys: keys,
      }).pipe(Effect.catch((error) => Effect.succeed(error))),
    );
    // Then the tagged failure retains its reason, requested keys and public allowlist.
    expect(error).toMatchObject({
      _tag: "JsonProjectionError",
      reason,
      keys,
      available: value === "ada" ? [] : ["kind", "name", "age"],
    });
  });
});
