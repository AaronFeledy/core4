import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema } from "../../src/cli/oclif/command-base.ts";
import { encodeCommandResult } from "../../src/cli/result-encode.ts";

class ExampleTaggedError extends Schema.TaggedError<ExampleTaggedError>()("ExampleTaggedError", {
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}

const plainRedactor = createRedactor("secrets", { values: [] });

const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

describe("encodeCommandResult", () => {
  test("wraps a schema-encoded success result in a command envelope", () => {
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:info",
        resultSchema: Schema.Struct({ name: Schema.String }),
        outcome: { _tag: "success", value: { name: "demo" } },
        redactor: plainRedactor,
      }),
    );

    const envelope = decodeEnvelope(line);
    expect(envelope).toMatchObject({
      apiVersion: "v4",
      command: "app:info",
      ok: true,
      result: { name: "demo" },
      warnings: [],
      deprecations: [],
    });
    expect(envelope.error).toBeUndefined();
  });

  test("encodes no-payload command results as an empty object", () => {
    const line = Effect.runSync(
      encodeCommandResult({
        command: "meta:version",
        resultSchema: EmptyResultSchema,
        outcome: { _tag: "success", value: {} },
        redactor: plainRedactor,
      }),
    );

    const envelope = decodeEnvelope(line);
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toEqual({});
  });

  test("wraps tagged failures in an ok:false envelope", () => {
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:start",
        resultSchema: EmptyResultSchema,
        outcome: {
          _tag: "failure",
          error: new ExampleTaggedError({ message: "provider missing", remediation: "Run setup." }),
        },
        redactor: plainRedactor,
      }),
    );

    const envelope = decodeEnvelope(line);
    expect(envelope.ok).toBe(false);
    expect(envelope.result).toBeUndefined();
    expect(envelope.error).toEqual({
      _tag: "ExampleTaggedError",
      message: "provider missing",
      remediation: "Run setup.",
    });
  });

  test("redacts secrets in success and failure envelopes", () => {
    const redactor = createRedactor("secrets", { values: ["topsecret"] });
    const success = Effect.runSync(
      encodeCommandResult({
        command: "app:info",
        resultSchema: Schema.Struct({ token: Schema.String }),
        outcome: { _tag: "success", value: { token: "topsecret" } },
        redactor,
      }),
    );
    const failure = Effect.runSync(
      encodeCommandResult({
        command: "app:start",
        resultSchema: EmptyResultSchema,
        outcome: { _tag: "failure", error: new Error("failed with topsecret") },
        redactor,
      }),
    );

    expect(success).toContain("[redacted]");
    expect(success).not.toContain("topsecret");
    expect(failure).toContain("[redacted]");
    expect(failure).not.toContain("topsecret");
    expect(decodeEnvelope(success).result).toEqual({ token: "[redacted]" });
    expect(decodeEnvelope(failure).error?.message).toBe("failed with [redacted]");
  });
});
