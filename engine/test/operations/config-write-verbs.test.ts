import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { runSetVerb } from "../../src/config-write/verbs.ts";
import { decodeIssues, writeValidationErrorFromIssues } from "../../src/config-write/write-core.ts";

const file = "/tmp/.lando.yml";
const decode = Schema.decodeUnknownResult(
  Schema.Struct({ name: Schema.String, port: Schema.optionalKey(Schema.Number) }),
);

const fixture = () => {
  const calls: string[] = [];
  const writes: Array<{ file: string; text: string }> = [];
  return {
    calls,
    writes,
    io: {
      file,
      readTree: Effect.sync(() => {
        calls.push("read");
        return { name: "app", port: 80 };
      }),
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
    const expected = writeValidationErrorFromIssues({
      file,
      path: "port",
      issues: decodeIssues(decode({ name: "app", port: "bad" })),
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
          readTree: Effect.fail(error),
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
});
