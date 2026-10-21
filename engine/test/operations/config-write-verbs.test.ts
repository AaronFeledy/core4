import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";

import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { ConfigError } from "@lando/sdk/errors";
import { validationIssue, validationIssuesFromCause } from "@lando/sdk/schema";
import { runSetVerb, runUnsetVerb } from "../../src/config-write/verbs.ts";
import { writeValidationErrorFromIssues } from "../../src/config-write/write-core.ts";

const file = "/tmp/.lando.yml";
const decode = (input: unknown) =>
  Schema.decodeUnknownResult(Schema.Struct({ name: Schema.String, port: Schema.optionalKey(Schema.Number) }))(
    input,
  ).pipe(Result.mapError((cause) => validationIssuesFromCause(cause)));

const fixture = () => {
  const calls: string[] = [];
  const writes: Array<{ file: string; text: string }> = [];
  return {
    calls,
    writes,
    io: {
      file,
      readText: Effect.sync(() => {
        calls.push("read");
        return "name: app\nport: 80\n";
      }),
      parse: parseMinimalYaml,
      editCommand: "lando config edit",
      decode,
      writeText: (file: string, text: string) =>
        Effect.sync(() => {
          calls.push("write");
          writes.push({ file, text });
        }),
    },
  };
};

describe("config write verbs", () => {
  test.each([
    [Schema.Number, "90", 90],
    [Schema.Boolean, "true", true],
    [Schema.Record(Schema.String, Schema.Number), '{"count":2}', { count: 2 }],
    [Schema.NullOr(Schema.Number), "null", null],
    [Schema.String, "8.0", "8.0"],
    [Schema.Union([Schema.String, Schema.Number]), "8080", "8080"],
    [Schema.Union([Schema.String, Schema.Array(Schema.String)]), '["serve"]', '["serve"]'],
    [Schema.String, "  '8.0'  ", "  '8.0'  "],
    [Schema.String, "{a: 1}", "{a: 1}"],
  ])("infers the first valid interpretation for %s and %s", async (schema, raw, expected) => {
    // Given
    const { io } = fixture();
    const decodeValue = (tree: unknown) =>
      Schema.decodeUnknownResult(Schema.Struct({ value: schema }))(tree).pipe(
        Result.mapError(validationIssuesFromCause),
      );
    // When
    const result = await Effect.runPromise(
      runSetVerb({ ...io, decode: decodeValue, key: "value", raw, dryRun: true }),
    );
    // Then
    expect(result.value).toEqual(expected);
  });

  test("keeps explicit string parsing authoritative on a number field", async () => {
    // Given
    const { io, writes } = fixture();
    // When
    const result = await Effect.runPromise(
      Effect.result(runSetVerb({ ...io, key: "port", raw: "90", type: "string", dryRun: false })),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(writes).toEqual([]);
  });

  test("labels unique issues and deduplicates shared issues when neither interpretation validates", async () => {
    // Given
    const { io } = fixture();
    const shared = validationIssue(["name"], "Existing invalid name");
    const decode = (tree: unknown) =>
      Result.fail([
        shared,
        shared,
        validationIssue(
          ["port"],
          typeof tree === "object" && tree !== null && "port" in tree && typeof tree.port === "string"
            ? "Expected number"
            : "Port out of range",
        ),
      ]);
    // When
    const result = await Effect.runPromise(
      Effect.result(runSetVerb({ ...io, decode, key: "port", raw: "90", dryRun: true })),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.path).toBe("port");
      expect(result.failure.issues).toEqual([
        validationIssue(["name"], "already present before this change: Existing invalid name"),
        validationIssue(["port"], "as text: Expected number"),
        validationIssue(["port"], "already present before this change: Port out of range"),
      ]);
      expect(result.failure.remediation).toContain("already present before this change first");
    }
  });

  test("tries malformed flow input only as its original text", async () => {
    // Given
    const { io } = fixture();
    const values: unknown[] = [];
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runSetVerb({
          ...io,
          key: "port",
          raw: "{a: 1}",
          dryRun: true,
          decode: (tree) => {
            values.push(tree);
            return decode(tree);
          },
        }),
      ),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    expect(values).toEqual([
      { name: "app", port: "{a: 1}" },
      { name: "app", port: 80 },
    ]);
    if (Result.isFailure(result)) expect(result.failure.remediation).not.toContain("--type");
  });

  test("runs afterDecode once on the winner without decoding defaults back into authored YAML", async () => {
    // Given
    const { io, writes } = fixture();
    const decodedValues: unknown[] = [];
    const winners: unknown[] = [];
    const schema = Schema.Struct({
      name: Schema.String,
      port: Schema.Number,
      enabled: Schema.optionalKey(Schema.Boolean).pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
    });
    // When
    await Effect.runPromise(
      runSetVerb({
        ...io,
        key: "port",
        raw: "90",
        dryRun: false,
        decode: (tree) => {
          decodedValues.push(tree);
          return Schema.decodeUnknownResult(schema)(tree).pipe(Result.mapError(validationIssuesFromCause));
        },
        afterDecode: (decoded) => {
          winners.push(decoded);
          return undefined;
        },
      }),
    );
    // Then
    expect(decodedValues).toEqual([
      { name: "app", port: "90" },
      { name: "app", port: 90 },
    ]);
    expect(winners).toEqual([Result.succeed({ name: "app", port: 90, enabled: true })]);
    expect(writes).toEqual([{ file, text: "name: app\nport: 90\n" }]);
  });

  test("aborts immediately when the decoder Effect fails", async () => {
    // Given
    const { io, writes } = fixture();
    const error = new ConfigError({ message: "Decoder read failed", path: file });
    let attempts = 0;
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runSetVerb({
          ...io,
          key: "port",
          raw: "90",
          dryRun: false,
          decode: () => {
            attempts += 1;
            return Effect.fail(error);
          },
        }),
      ),
    );
    // Then
    expect(result).toEqual(Result.fail(error));
    expect(attempts).toBe(1);
    expect(writes).toEqual([]);
  });

  test.each([
    ["app", true],
    [42, false],
  ])("repairs the target while still validating unrelated fields (%s)", async (name, succeeds) => {
    // Given
    const { io } = fixture();
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runSetVerb({
          ...io,
          readText: Effect.succeed(`name: ${name}\nport: invalid\n`),
          key: "port",
          raw: "90",
          dryRun: true,
        }),
      ),
    );
    // Then
    expect(Result.isSuccess(result)).toBe(succeeds);
    if (Result.isSuccess(result)) expect(result.success.value).toBe(90);
  });

  test("set emits canonical YAML when writing a typed value", async () => {
    // Given
    const { io, writes, calls } = fixture();
    // When
    const result = await Effect.runPromise(
      runSetVerb({ ...io, key: "port", raw: "90", type: "number", dryRun: false }),
    );
    // Then
    expect(result).toEqual({ key: "port", value: 90, changed: true, dryRun: false });
    expect(writes).toEqual([{ file, text: "name: app\nport: 90\n" }]);
    expect(calls).toEqual(["read", "write"]);
  });

  test("set skips writing when dry-running", async () => {
    // Given
    const { io, writes } = fixture();
    // When
    const result = await Effect.runPromise(
      runSetVerb({ ...io, key: "port", raw: "90", type: "number", dryRun: true }),
    );
    // Then
    expect(result).toEqual({ key: "port", value: 90, changed: true, dryRun: true });
    expect(writes).toEqual([]);
  });

  test("set fails with file and key context when decoding rejects the mutation", async () => {
    // Given
    const { io, writes } = fixture();
    const decoded = decode({ name: "app", port: "bad" });
    const expected = writeValidationErrorFromIssues({
      file,
      path: "port",
      issues: Result.isFailure(decoded) ? decoded.failure : [],
    });
    // When
    const result = await Effect.runPromise(
      Effect.result(runSetVerb({ ...io, key: "port", raw: "bad", type: "string", dryRun: false })),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toEqual(expected);
    expect(writes).toEqual([]);
  });

  test("set propagates afterDecode failures before writing", async () => {
    // Given
    const { io, writes, calls } = fixture();
    const error = new ConfigError({ message: "Rejected by policy", path: file });
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runSetVerb({
          ...io,
          key: "port",
          raw: "90",
          type: "number",
          dryRun: true,
          afterDecode: () => {
            calls.push("afterDecode");
            return error;
          },
        }),
      ),
    );
    // Then
    if (Result.isFailure(result)) expect(result.failure).toBe(error);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual(["read", "afterDecode"]);
    expect(writes).toEqual([]);
  });

  test("set propagates read failures before mutation or decoding", async () => {
    // Given
    const { io, writes } = fixture();
    const error = new ConfigError({ message: "Read failed", path: file });
    // When
    const result = await Effect.runPromise(
      Effect.result(
        runSetVerb({
          ...io,
          readText: Effect.fail(error),
          key: "",
          raw: "bad",
          type: "number",
          dryRun: false,
        }),
      ),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBe(error);
    expect(writes).toEqual([]);
  });

  test("unset labels issues that were already present before the change", async () => {
    // Given
    const { io, writes } = fixture();
    const existing = validationIssue(["name"], "Existing invalid name");
    const decode = (tree: unknown) =>
      Result.fail(
        typeof tree === "object" && tree !== null && "port" in tree
          ? [existing]
          : [existing, validationIssue(["port"], "Port is required")],
      );
    // When
    const result = await Effect.runPromise(
      Effect.result(runUnsetVerb({ ...io, decode, key: "port", dryRun: false })),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.issues).toEqual([
        validationIssue(["name"], "already present before this change: Existing invalid name"),
        validationIssue(["port"], "Port is required"),
      ]);
      expect(result.failure.remediation).toContain("already present before this change first");
    }
    expect(writes).toEqual([]);
  });
});
