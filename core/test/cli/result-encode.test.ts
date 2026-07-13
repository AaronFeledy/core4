import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileVersionConstraintError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema } from "../../src/cli/oclif/command-base.ts";
import {
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
} from "../../src/cli/result-encode.ts";

class ExampleTaggedError extends Schema.TaggedError<ExampleTaggedError>()("ExampleTaggedError", {
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}

const plainRedactor = createRedactor("secrets", { values: [] });

const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
const decodeFrame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

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

  test("preserves provenance-bearing version-constraint messages in normal and streaming failures", () => {
    const error = new LandofileVersionConstraintError({
      message:
        'The running Lando version 4.2.0 does not satisfy ">=5" from .lando.base.yml (base layer, order 0).',
      constraints: [{ range: ">=5", source: ".lando.base.yml", layer: "base", order: 0 }],
      runningVersion: "4.2.0",
      remediation: "Update Lando.",
    });
    const options = {
      command: "app:info",
      resultSchema: EmptyResultSchema,
      outcome: { _tag: "failure", error } as const,
      redactor: plainRedactor,
    };

    const envelope = decodeEnvelope(Effect.runSync(encodeCommandResult(options)));
    const frame = decodeFrame(Effect.runSync(encodeStreamResultFrame(options)));

    expect(envelope.error).toEqual({
      _tag: "LandofileVersionConstraintError",
      message:
        'The running Lando version 4.2.0 does not satisfy ">=5" from .lando.base.yml (base layer, order 0).',
      remediation: "Update Lando.",
    });
    expect(frame).toMatchObject({
      _tag: "result",
      envelope: { error: envelope.error },
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

describe("StreamFrame encoders", () => {
  test("wraps a command envelope in a terminal result frame", () => {
    const line = Effect.runSync(
      encodeStreamResultFrame({
        command: "app:logs",
        resultSchema: Schema.Struct({ lines: Schema.Number }),
        outcome: { _tag: "success", value: { lines: 2 } },
        redactor: plainRedactor,
      }),
    );

    const frame = decodeFrame(line);
    expect(frame._tag).toBe("result");
    if (frame._tag !== "result") throw new Error("expected result frame");
    expect(frame.envelope).toMatchObject({
      apiVersion: "v4",
      command: "app:logs",
      ok: true,
      result: { lines: 2 },
      warnings: [],
      deprecations: [],
    });
  });

  test("encodes event frames and redacts payload values", () => {
    const redactor = createRedactor("secrets", { values: ["super-secret"] });
    const line = Effect.runSync(
      encodeStreamEventFrame({
        event: "task.detail",
        payload: { line: "token=super-secret" },
        redactor,
      }),
    );

    expect(line).toContain("[redacted]");
    expect(line).not.toContain("super-secret");
    const frame = decodeFrame(line);
    expect(frame._tag).toBe("event");
    if (frame._tag !== "event") throw new Error("expected event frame");
    expect(frame.event).toBe("task.detail");
    expect((frame.payload as { readonly line?: string }).line).toContain("[redacted]");
    expect((frame.payload as { readonly line?: string }).line).not.toContain("super-secret");
  });

  test("encodes stdout and stderr chunk frames", () => {
    const stdout = decodeFrame(
      Effect.runSync(
        encodeStreamStdoutFrame({ chunk: "hello\n", service: "appserver", redactor: plainRedactor }),
      ),
    );
    const stderr = decodeFrame(
      Effect.runSync(encodeStreamStderrFrame({ chunk: "warn\n", redactor: plainRedactor })),
    );

    expect(stdout).toEqual({ _tag: "stdout", chunk: "hello\n", service: "appserver" });
    expect(stderr).toEqual({ _tag: "stderr", chunk: "warn\n" });
  });
});
