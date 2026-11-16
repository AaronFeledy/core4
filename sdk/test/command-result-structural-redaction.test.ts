// Literal preservation keeps decoding discriminants and declared keys, but it
// does not make every redacted document schema-valid: a free-text refinement can
// still reject the [redacted] value the policy produced.
import { describe, expect, test } from "bun:test";
import {
  commandResultEnvelopePolicy,
  encodeCommandResult,
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  redactValueWithPolicy,
  structuralRedaction,
} from "@lando/sdk/command-result";
import { LandoEvent, TaskDetailEvent } from "@lando/sdk/events";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";

const envelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
const frame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

const resultOptions = (value: unknown, resultSchema: Schema.Codec<unknown, unknown>, values: string[]) => ({
  command: "test:result",
  resultSchema,
  outcome: { _tag: "success" as const, value },
  redactor: createRedactor("secrets", { values }),
});

describe("schema-fixed string exemptions", () => {
  test("keeps envelope and result literals while free text stays redacted", () => {
    const resultSchema = Schema.Struct({
      kind: Schema.Literals(["tooling", "plugin"]),
      message: Schema.String,
    });
    const input = resultOptions({ kind: "tooling", message: "tooling broke" }, resultSchema, [
      "tooling",
      "v4",
    ]);
    const line = Effect.runSync(encodeCommandResult(input));
    const decoded = envelope(line);
    expect(decoded.apiVersion).toBe("v4");
    expect(decoded.result).toEqual({ kind: "tooling", message: `${REDACTED} broke` });
    expect(line).not.toContain("tooling broke");
    expect(decoded.ok).toBe(true);
    const yaml = Bun.YAML.parse(Effect.runSync(encodeCommandResult({ ...input, format: "yaml" })));
    expect(yaml).toEqual(JSON.parse(line));
  });

  test("keeps schema-declared keys and redacts dynamic keys", () => {
    const declared = Schema.Struct({ command: Schema.Literal("safe") });
    const declaredLine = Effect.runSync(
      encodeCommandResult(resultOptions({ command: "safe" }, declared, ["command"])),
    );
    expect(envelope(declaredLine).result).toEqual({ command: "safe" });

    const declaredText = Schema.Struct({ command: Schema.String });
    const textLine = Effect.runSync(
      encodeCommandResult(resultOptions({ command: "run" }, declaredText, ["command"])),
    );
    expect(envelope(textLine).result).toEqual({ command: "run" });

    const dynamic = Schema.Record(Schema.String, Schema.String);
    const dynamicLine = Effect.runSync(
      encodeCommandResult(resultOptions({ "dynamic-secret": "value" }, dynamic, ["dynamic-secret"])),
    );
    expect(JSON.parse(dynamicLine).result).toEqual({ [REDACTED]: "value" });
  });
});

describe("ambiguous schema positions stay redacted", () => {
  test("a String union member keeps a literal redacted", () => {
    const ambiguous = Schema.Union([Schema.Literal("tooling"), Schema.String]);
    const line = Effect.runSync(encodeCommandResult(resultOptions("tooling", ambiguous, ["tooling"])));
    expect(JSON.parse(line).result).toBe(REDACTED);
  });

  test("an Unknown union member keeps a matched struct redacted", () => {
    const ambiguous = Schema.Union([Schema.Struct({ kind: Schema.Literal("tooling") }), Schema.Unknown]);
    const line = Effect.runSync(
      encodeCommandResult(resultOptions({ kind: "tooling" }, ambiguous, ["tooling", "kind"])),
    );
    expect(JSON.parse(line).result).toEqual({ [REDACTED]: REDACTED });
  });
});

describe("encoded transforms and classes", () => {
  test("keeps the encoded literal tag of a TaggedError class", () => {
    class SampleError extends Schema.TaggedError<SampleError>()("SampleError", {
      message: Schema.String,
    }) {}
    const line = Effect.runSync(
      encodeCommandResult(
        resultOptions(new SampleError({ message: "boom" }), SampleError, ["SampleError", "boom"]),
      ),
    );
    expect(envelope(line).result).toEqual({ _tag: "SampleError", message: REDACTED });
  });

  test("keeps literals inside recursive schemas", () => {
    interface Node {
      readonly kind: "node";
      readonly label: string;
      readonly children: ReadonlyArray<Node>;
    }
    const Node: Schema.Codec<Node> = Schema.Struct({
      kind: Schema.Literal("node"),
      label: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Node> => Node)),
    });
    const value: Node = {
      kind: "node",
      label: "node-label",
      children: [{ kind: "node", label: "child-label", children: [] }],
    };
    const line = Effect.runSync(
      encodeCommandResult(resultOptions(value, Node, ["node", "node-label", "child-label"])),
    );
    expect(envelope(line).result).toEqual({
      kind: "node",
      label: REDACTED,
      children: [{ kind: "node", label: REDACTED, children: [] }],
    });
  });
});

describe("projection and frames", () => {
  test("keeps literal projection keys", () => {
    const resultSchema = Schema.Struct({ kind: Schema.Literal("tooling"), message: Schema.String });
    const line = Effect.runSync(
      encodeCommandResult({
        ...resultOptions({ kind: "tooling", message: "tooling" }, resultSchema, ["tooling"]),
        projectResultKeys: ["kind"],
      }),
    );
    expect(envelope(line).result).toEqual({ kind: "tooling" });
  });

  test("keeps stream-frame literals in result and real-event frames", () => {
    const redactor = createRedactor("secrets", {
      values: ["result", "v4", "event", "task.detail", "stdout"],
    });
    const terminal = frame(
      Effect.runSync(
        encodeStreamResultFrame({
          ...resultOptions({ kind: "tooling" }, Schema.Struct({ kind: Schema.Literal("tooling") }), []),
          redactor,
        }),
      ),
    );
    expect(terminal).toMatchObject({ _tag: "result", envelope: { apiVersion: "v4" } });

    const event = {
      _tag: "task.detail",
      taskId: "task.detail",
      stream: "stdout",
      line: "stream output",
    } as const;
    const eventFrame = frame(
      Effect.runSync(
        encodeStreamEventFrame({
          event: event._tag,
          payload: event,
          payloadSchema: TaskDetailEvent,
          redactor,
        }),
      ),
    );
    expect(eventFrame).toEqual({
      _tag: "event",
      event: "task.detail",
      payload: { _tag: "task.detail", taskId: REDACTED, stream: "stdout", line: "stream output" },
    });
  });

  test("real lifecycle events narrow through the LandoEvent union", () => {
    const redactor = createRedactor("secrets", { values: ["task.detail", "stderr"] });
    const event = { _tag: "task.detail", taskId: "id", stream: "stderr", line: "line" } as const;
    const decoded = frame(
      Effect.runSync(
        encodeStreamEventFrame({
          event: "task.detail",
          payload: event,
          payloadSchema: LandoEvent,
          redactor,
        }),
      ),
    );
    expect(decoded).toEqual({
      _tag: "event",
      event: "task.detail",
      payload: { _tag: "task.detail", taskId: "id", stream: "stderr", line: "line" },
    });
  });
});

describe("runtime value redaction", () => {
  test("keeps runtime event literals while redacting free text and preserving shape", () => {
    const redactor = createRedactor("secrets", { values: ["task.detail", "stdout", "line-text"] });
    const event = {
      _tag: "task.detail",
      taskId: "line-text",
      stream: "stdout",
      line: "line-text",
      timestamp: "2026-10-30T00:00:00Z",
    };
    const redacted = redactValueWithPolicy(redactor, structuralRedaction(LandoEvent, "type"), event);
    expect(redacted).toEqual({
      _tag: "task.detail",
      stream: "stdout",
      taskId: REDACTED,
      line: REDACTED,
      timestamp: "2026-10-30T00:00:00Z",
    });
  });

  test("reusing one union policy across members keeps each member's own literals", () => {
    const redactor = createRedactor("secrets", {
      values: ["task.detail", "stdout", "stderr", "task.complete", "warn", "summary-text"],
    });
    const policy = structuralRedaction(LandoEvent, "type");
    const detail = (stream: "stdout" | "stderr") =>
      redactValueWithPolicy(redactor, policy, { _tag: "task.detail", taskId: "id", stream, line: "line" });
    const complete = redactValueWithPolicy(redactor, policy, {
      _tag: "task.complete",
      taskId: "id",
      summary: "summary-text",
      outcome: "warn",
    });

    expect(detail("stdout")).toMatchObject({ _tag: "task.detail", stream: "stdout", taskId: "id" });
    expect(complete).toMatchObject({ _tag: "task.complete", taskId: "id", outcome: "warn" });
    expect(complete).toMatchObject({ summary: REDACTED });
    expect(detail("stderr")).toMatchObject({ _tag: "task.detail", stream: "stderr" });
  });

  test("reuses array element nodes without losing tuple rest positions", () => {
    const redactor = createRedactor("secrets", { values: ["head", "a", "b", "tail"] });
    const array = structuralRedaction(Schema.Array(Schema.Literals(["a", "b"])));
    expect(redactValueWithPolicy(redactor, array, ["a", "b", "a"])).toEqual(["a", "b", "a"]);
    expect(redactValueWithPolicy(redactor, array, ["b"])).toEqual(["b"]);

    const tuple = Schema.TupleWithRest(Schema.Tuple([Schema.Literal("head")]), [
      Schema.Literals(["a", "b"]),
      Schema.Literal("tail"),
    ]);
    const rest = structuralRedaction(tuple);
    const full = ["head", "a", "b", "tail"];
    expect(redactValueWithPolicy(redactor, rest, full)).toEqual(full);
    expect(redactValueWithPolicy(redactor, rest, ["head", "a", "tail"])).toEqual(["head", "a", "tail"]);
  });

  test("narrowing never invokes an accessor discriminant", () => {
    const policy = structuralRedaction(LandoEvent, "type");
    let calls = 0;
    const readTag = () => {
      calls += 1;
      return "task.detail";
    };
    const value: Record<string, unknown> = { taskId: "id", stream: "stdout", line: "line" };
    Object.defineProperty(value, "_tag", { enumerable: true, get: readTag });
    expect(policy.child("taskId", value)?.stringIsExempt("id") ?? false).toBe(false);
    expect(calls).toBe(0);
  });

  test("keeps cyclic values from throwing", () => {
    const value: Record<string, unknown> = { _tag: "message.info", body: "body" };
    value.self = value;
    const redacted = redactValueWithPolicy(
      createRedactor("secrets"),
      structuralRedaction(LandoEvent, "type"),
      value,
    );
    expect(redacted).toMatchObject({ self: "[circular]" });
  });
});

test("the exported envelope policy compiles once per result schema", () => {
  const schema = Schema.Struct({ kind: Schema.Literal("tooling") });
  expect(commandResultEnvelopePolicy(schema)).toBe(commandResultEnvelopePolicy(schema));
});
