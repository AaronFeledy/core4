import { describe, expect, test } from "bun:test";
import {
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
  identityRedactor,
} from "@lando/sdk/command-result";
import { SecretNotFoundError } from "@lando/sdk/errors";
import {
  BoundText,
  CommandResultEnvelope,
  EnvironmentValue,
  SecretRef,
  StreamFrame,
} from "@lando/sdk/schema";
import { REDACTED, type Redactor, createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";

const options = (value: unknown, redactor: Redactor) => ({
  command: "test:result",
  resultSchema: Schema.Unknown,
  outcome: { _tag: "success" as const, value },
  redactor,
});
const envelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
const frame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

test("redacts secrets inside nested tagged cause messages in the envelope", () => {
  const redactor = createRedactor("secrets", { values: ["nested-secret"] });
  const line = Effect.runSync(
    encodeCommandResult({
      command: "app:start",
      resultSchema: Schema.Void,
      outcome: {
        _tag: "failure",
        error: {
          _tag: "Outer",
          message: "Failed.",
          cause: { _tag: "Inner", message: "Could not read nested-secret." },
        },
        additionalErrors: [],
      },
      redactor,
    }),
  );

  expect(envelope(line).error?.cause).toMatchObject({
    _tag: "Inner",
    message: `Could not read ${REDACTED}.`,
  });
  expect(line).not.toContain("nested-secret");
});

for (const [label, secret, primitive] of [
  ["truth", "true", true],
  ["falsehood", "false", false],
  ["null", "null", null],
  ["number", "12345", 12345],
] as const) {
  test(`preserves ${label} primitives while masking matching strings in JSON, YAML, and frames`, () => {
    const redactor = createRedactor("secrets", { values: [secret] });
    const input = options({ primitive, text: secret, nested: { [secret]: [primitive, secret] } }, redactor);
    const expected = { primitive, text: REDACTED, nested: { [REDACTED]: [primitive, REDACTED] } };
    const json = envelope(Effect.runSync(encodeCommandResult(input)));
    const yaml = Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })));
    expect(json.ok).toBe(true);
    expect(json.result).toEqual(expected);
    expect(yaml).toEqual(json);
    const event = frame(
      Effect.runSync(
        encodeStreamEventFrame({ event: "task.detail", payload: input.outcome.value, redactor }),
      ),
    );
    expect(event).toEqual({ _tag: "event", event: "task.detail", payload: expected });
    const terminal = frame(Effect.runSync(encodeStreamResultFrame(input)));
    expect(terminal).toEqual({ _tag: "result", envelope: json });

    const invalid = { ...input, command: secret, resultSchema: Schema.Number };
    const fallback = envelope(Effect.runSync(encodeCommandResult(invalid)));
    expect(fallback.ok).toBe(false);
    expect(fallback.command).toBe(REDACTED);
    expect(fallback.error?._tag).toBe("CommandResultEncodeError");
    expect(Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...invalid, format: "yaml" })))).toEqual(
      fallback,
    );
    expect(frame(Effect.runSync(encodeStreamResultFrame(invalid)))).toEqual({
      _tag: "result",
      envelope: fallback,
    });
  });
}

for (const [label, secret] of [
  ["quote", 'quote"canary'],
  ["backslash", "slash\\canary"],
  ["controls", "control\tline\ncanary\u0000"],
  ["Unicode", "秘密🙂"],
  ["lone surrogate", "canary-\ud800"],
] as const) {
  test(`redacts decoded ${label} strings in nested keys and values`, () => {
    const redactor = createRedactor("secrets", { values: [secret] });
    const input = options({ nested: { [secret]: `before ${secret} after` } }, redactor);
    const expected = { nested: { [REDACTED]: `before ${REDACTED} after` } };
    const json = envelope(Effect.runSync(encodeCommandResult(input)));
    expect(json.result).toEqual(expected);
    expect(Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })))).toEqual(json);
    expect(frame(Effect.runSync(encodeStreamResultFrame(input)))).toEqual({ _tag: "result", envelope: json });
    expect(
      frame(
        Effect.runSync(
          encodeStreamEventFrame({ event: "task.detail", payload: input.outcome.value, redactor }),
        ),
      ),
    ).toEqual({ _tag: "event", event: "task.detail", payload: expected });
  });
}

test("redacts literal escape values in encoded string tokens", () => {
  const redactor = createRedactor("secrets", { values: [String.raw`\n`, String.raw`\"`] });
  const input = options({ newline: "x\ny", quote: 'x"y', literal: String.raw`x\ny` }, redactor);
  expect(envelope(Effect.runSync(encodeCommandResult(input))).result).toEqual({
    newline: `x${REDACTED}y`,
    quote: `x${REDACTED}y`,
    literal: `x${REDACTED}y`,
  });
});

test("uses the last serialized property when redacted keys collide", () => {
  const redactor = createRedactor("secrets", { values: ["first-canary", "second-canary"] });
  const input = options({ "first-canary": "first", "second-canary": "second" }, redactor);
  const json = envelope(Effect.runSync(encodeCommandResult(input)));
  expect(json.result).toEqual({ [REDACTED]: "second" });
  expect(Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })))).toEqual(json);
  expect(frame(Effect.runSync(encodeStreamResultFrame(input)))).toEqual({ _tag: "result", envelope: json });
  expect(
    frame(
      Effect.runSync(
        encodeStreamEventFrame({ event: "task.detail", payload: input.outcome.value, redactor }),
      ),
    ),
  ).toEqual({ _tag: "event", event: "task.detail", payload: { [REDACTED]: "second" } });
});

test("preserves untouched escaped strings and primitive spans with an identity redactor", () => {
  const payload = {
    text: '"\\\b\f\n\r\t\u0000\u001f🙂秘密\ud800\udfff',
    primitives: [true, false, null, 12345, -1.25, 1e23],
    jsonLike: '{"nested":[true,null,"quoted"]}',
  };
  const input = options(payload, identityRedactor);
  expect(envelope(Effect.runSync(encodeCommandResult(input))).result).toEqual(payload);
  expect(
    frame(
      Effect.runSync(encodeStreamEventFrame({ event: "task.detail", payload, redactor: identityRedactor })),
    ),
  ).toEqual({ _tag: "event", event: "task.detail", payload });
});

test("masks a whole string token when encoded redaction breaks an escape", () => {
  const input = options({ leaf: "x\nx" }, createRedactor("secrets", { values: ["n"] }));
  const parsed = JSON.parse(Effect.runSync(encodeCommandResult(input))) as { result: { leaf: unknown } };
  expect(parsed.result.leaf).toBe(REDACTED);
});

test("masks a whole token when encoded redaction produces a non-string JSON value", () => {
  const redactor = {
    ...identityRedactor,
    redactString: (text: string) => (text === '"synthetic-value"' ? "false" : text),
  };
  const input = options({ leaf: "synthetic-value" }, redactor);
  expect(envelope(Effect.runSync(encodeCommandResult(input))).result).toEqual({ leaf: REDACTED });
});

test("masks a whole token when the redactor throws without returning raw detail", () => {
  const redactor = {
    ...identityRedactor,
    redactString: (text: string) => {
      if (text.includes("synthetic-value")) throw new Error("synthetic redactor failure");
      return text;
    },
  };
  expect(
    envelope(Effect.runSync(encodeCommandResult(options({ leaf: "synthetic-value" }, redactor)))),
  ).toMatchObject({
    ok: true,
    result: { leaf: REDACTED },
  });
});

test("keeps JSON stringify serializers, omission, and array conversion semantics", () => {
  let calls = 0;
  const input = options(
    {
      nested: {
        toJSON: (key: string) => {
          calls += 1;
          return { key, omitted: undefined, list: [undefined, Number.NaN], text: "synthetic-value" };
        },
      },
    },
    createRedactor("secrets", { values: ["synthetic-value"] }),
  );
  expect(envelope(Effect.runSync(encodeCommandResult(input))).result).toEqual({
    nested: { key: "nested", list: [null, null], text: REDACTED },
  });
  expect(calls).toBe(1);
});

test("retains assignment, userinfo, bearer, and signed-query pattern masking", () => {
  const input = options(
    {
      assignment: 'PASSWORD="synthetic-value"',
      userinfo: "https://example:synthetic-value@host/path",
      bearer: "Bearer synthetic-value",
      query: "https://host/path?access_token=synthetic-value&safe=1",
    },
    createRedactor("secrets"),
  );
  const json = envelope(Effect.runSync(encodeCommandResult(input)));
  expect(json.result).toEqual({
    assignment: `PASSWORD=${REDACTED}`,
    userinfo: `https://${REDACTED}@host/path`,
    bearer: REDACTED,
    query: `https://host/path?access_token=${REDACTED}&safe=1`,
  });
  expect(Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })))).toEqual(json);
});

test("uses redacted frame and envelope fallbacks when JSON serialization fails", () => {
  const redactor = createRedactor("secrets", { values: ["Failed", "stream-frame", "false"] });
  const event = frame(
    Effect.runSync(encodeStreamEventFrame({ event: "task.detail", payload: 1n, redactor })),
  );
  expect(event).toEqual({
    _tag: "event",
    event: `${REDACTED}-encode-error`,
    payload: { message: `${REDACTED} to encode stream frame.` },
  });
  const input = options(1n, redactor);
  expect(frame(Effect.runSync(encodeStreamResultFrame(input)))).toEqual(event);
  const fallback = envelope(Effect.runSync(encodeCommandResult(input)));
  expect(fallback.ok).toBe(false);
  expect(fallback.error?.message).toBe(`${REDACTED} to encode command result.`);
  expect(Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })))).toEqual(fallback);
});

test("preserves chunk pre-redaction and identity serialization", () => {
  const redactor = {
    ...identityRedactor,
    redactString: (text: string) => `${text}!`,
  };
  for (const encode of [encodeStreamStdoutFrame, encodeStreamStderrFrame]) {
    expect(
      frame(Effect.runSync(encode({ chunk: "hello\n", service: "app", source: "task", redactor }))),
    ).toMatchObject({
      chunk: "hello\n!",
      service: "app!",
      source: "task!",
    });
  }
});

describe("one secret-named-field rule in machine envelopes", () => {
  const redactor = createRedactor("secrets");
  const emit = (value: unknown, resultSchema: Schema.Codec<unknown, unknown>) => {
    const input = {
      command: "test:result",
      resultSchema,
      outcome: { _tag: "success" as const, value },
      redactor,
    };
    const json = envelope(Effect.runSync(encodeCommandResult(input)));
    const yaml = Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })));
    return { json, yaml };
  };

  test("masks free text under a secret-named key in JSON and YAML", () => {
    // Given
    const resultSchema = Schema.Struct({ password: Schema.String, note: Schema.String });
    // When
    const { json, yaml } = emit({ password: "hunter2", note: "free text" }, resultSchema);
    // Then
    expect(json.result).toEqual({ password: REDACTED, note: "free text" });
    expect(yaml).toEqual(json);
  });

  test("keeps a deferred environment descriptor under its secret-named variable", () => {
    // Given the app:config model: a record of environment descriptors.
    const resultSchema = Schema.Record(Schema.String, EnvironmentValue);
    const value = {
      DB_PASSWORD: { _tag: "SecretRef" as const, reference: "DB_PASSWORD" },
      PLAIN: "visible",
    };
    // When
    const { json, yaml } = emit(value, resultSchema);
    // Then
    expect(json.result).toEqual(value);
    expect(yaml).toEqual(json);
  });

  test("keeps a secret descriptor under a secret-named key and still decodes", () => {
    // Given
    const resultSchema = Schema.Struct({ password: SecretRef });
    const value = { password: { _tag: "SecretRef" as const, reference: "DB_PASSWORD" } };
    // When
    const { json, yaml } = emit(value, resultSchema);
    // Then
    expect(json.result).toEqual(value);
    expect(yaml).toEqual(json);
    expect(Schema.decodeUnknownSync(resultSchema)(json.result)).toEqual(value);
  });

  test("walks a schema-declared object field by field under a secret-named key", () => {
    // Given
    const resultSchema = Schema.Struct({ password: Schema.Struct({ value: Schema.String }) });
    // When
    const { json, yaml } = emit({ password: { value: "hunter2" } }, resultSchema);
    // Then
    expect(json.result).toEqual({ password: { value: REDACTED } });
    expect(yaml).toEqual(json);
  });

  test("masks each entry of a record under a secret-named key", () => {
    // Given
    const resultSchema = Schema.Struct({ secretAnswers: Schema.Record(Schema.String, Schema.String) });
    // When
    const { json, yaml } = emit({ secretAnswers: { q1: "hunter2" } }, resultSchema);
    // Then
    expect(json.result).toEqual({ secretAnswers: { q1: REDACTED } });
    expect(yaml).toEqual(json);
  });

  test("keeps booleans, null, and schema-typed numbers while masking an opaque number", () => {
    // Given a number the schema types as a number and one it cannot type.
    const resultSchema = Schema.Struct({
      secretRedaction: Schema.Boolean,
      password: Schema.Null,
      apiToken: Schema.Number,
      secretCount: Schema.Unknown,
    });
    // When
    const { json, yaml } = emit(
      { secretRedaction: true, password: null, apiToken: 12345, secretCount: 7 },
      resultSchema,
    );
    // Then the typed number survives so the envelope still decodes; the opaque one masks.
    expect(json.result).toEqual({
      secretRedaction: true,
      password: null,
      apiToken: 12345,
      secretCount: REDACTED,
    });
    expect(yaml).toEqual(json);
    expect(Schema.decodeUnknownSync(resultSchema)(json.result)).toEqual({
      secretRedaction: true,
      password: null,
      apiToken: 12345,
      secretCount: REDACTED,
    });
  });

  test("masks BoundText literal parts under a secret-named key and keeps its references", () => {
    // Given
    const resultSchema = Schema.Struct({ password: BoundText });
    const value = {
      password: {
        _tag: "BoundText" as const,
        parts: ["literal-bytes", { reference: "DB_PASSWORD", encoding: "raw" as const }],
      },
    };
    // When
    const { json, yaml } = emit(value, resultSchema);
    // Then
    expect(json.result).toEqual({
      password: { _tag: "BoundText", parts: [REDACTED, { reference: "DB_PASSWORD", encoding: "raw" }] },
    });
    expect(yaml).toEqual(json);
  });
});

describe("tagged error diagnostics under the secret-named-field rule", () => {
  const redactor = createRedactor("secrets", { values: ["registered-token"] });
  const failure = (error: unknown) =>
    envelope(
      Effect.runSync(
        encodeCommandResult({
          command: "cli:unknown-command",
          resultSchema: Schema.Void,
          outcome: { _tag: "failure" as const, error, additionalErrors: [] },
          redactor,
        }),
      ),
    );

  test("keeps an unknown command's token readable in JSON and YAML", () => {
    // Given a tagged error whose own diagnostic field the name rule would mask.
    const error = {
      _tag: "UnknownCommandError",
      message: "Unknown command.",
      remediation: "Run lando help.",
      commandToken: "app:list:share",
    };
    // When
    const json = failure(error);
    const yaml = Bun.YAML.parse(
      Effect.runSync(
        encodeCommandResult({
          command: "cli:unknown-command",
          resultSchema: Schema.Void,
          outcome: { _tag: "failure" as const, error, additionalErrors: [] },
          redactor,
          format: "yaml",
        }),
      ),
    );
    // Then
    expect(json.error?.commandToken).toBe("app:list:share");
    expect(yaml).toEqual(json);
  });

  test("keeps a missing secret's id readable while a registered value still masks", () => {
    // Given the real tagged error and a token carrying a registered value.
    const missing = failure(
      new SecretNotFoundError({ message: "Missing secret.", secret: "MISSING_SECRET" }),
    );
    const masked = failure({
      _tag: "UnknownCommandError",
      message: "Unknown command.",
      remediation: "Run lando help.",
      commandToken: "app:registered-token",
    });
    // Then
    expect(missing.error).toMatchObject({ _tag: "SecretNotFoundError", secret: "MISSING_SECRET" });
    expect(masked.error?.commandToken).toBe(`app:${REDACTED}`);
  });
});
