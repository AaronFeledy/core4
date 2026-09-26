import { expect, test } from "bun:test";
import { encodeCommandResult, encodeStreamResultFrame } from "@lando/sdk/command-result";
import { SecretStoreUnavailableError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";

test("JSON error envelopes preserve a tagged secret-store reason", () => {
  // Given
  const error = new SecretStoreUnavailableError({
    storeId: "1password",
    reason: "cli-missing",
    message: "CLI unavailable",
    remediation: "Install the CLI.",
  });
  // When
  const line = Effect.runSync(
    encodeCommandResult({
      command: "app:start",
      resultSchema: Schema.Void,
      outcome: { _tag: "failure", error },
      redactor: createRedactor("secrets"),
    }),
  );
  // Then
  expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line)).error).toEqual({
    _tag: error._tag,
    message: error.message,
    remediation: error.remediation,
    reason: "cli-missing",
  });
});

test.each(["", "socket-missing", undefined, null, 42, { code: "locked" }])(
  "error envelopes preserve reason only when it is a string: %j",
  (reason) => {
    // Given
    const error = { _tag: "ExampleError", message: "Unavailable", reason };
    // When
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:start",
        resultSchema: Schema.Void,
        outcome: { _tag: "failure", error },
        redactor: createRedactor("secrets"),
      }),
    );
    // Then
    expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line)).error).toEqual({
      _tag: error._tag,
      message: error.message,
      ...(typeof reason === "string" ? { reason } : {}),
    });
  },
);

test("streamed result frames preserve reason through schema encoding", () => {
  // Given
  const error = { _tag: "SshAgentUnavailableError", message: "Unavailable", reason: "socket-missing" };
  // When
  const line = Effect.runSync(
    encodeStreamResultFrame({
      command: "app:start",
      resultSchema: Schema.Void,
      outcome: { _tag: "failure", error },
      redactor: createRedactor("secrets"),
    }),
  );
  // Then
  expect(Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line))).toMatchObject({
    _tag: "result",
    envelope: { ok: false, error },
  });
});
