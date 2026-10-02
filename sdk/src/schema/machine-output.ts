import { Schema } from "effect";

import { DeprecationUse } from "./deprecation.ts";

/** Command output formats; `json` and `ndjson` are machine-readable, others are human encodings. */
export const CommandResultFormat = Schema.Literals(["text", "json", "table", "yaml", "ndjson"]);
export type CommandResultFormat = typeof CommandResultFormat.Type;

export const CommandWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Structured string metadata that identifies the warning source and affected input.",
  }),
});
export type CommandWarning = typeof CommandWarning.Type;

const TaggedErrorJson = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        target: Schema.String,
        destructive: Schema.Boolean,
      }),
    )),
  reason: Schema.optionalKey(Schema.String).annotate({
    description: "Structured failure reason when supplied as a string by the source error.",
  }),
});

/** JSON envelope for `--format json` (and the terminal `result` stream frame). `apiVersion` changes only on breaking envelope edits. */
export const CommandResultEnvelope = Schema.Struct({
  apiVersion: Schema.Literal("v4"),
  command: Schema.String,
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(TaggedErrorJson),
  warnings: Schema.Array(CommandWarning),
  deprecations: Schema.Array(DeprecationUse),
});
export type CommandResultEnvelope = typeof CommandResultEnvelope.Type;

/** One NDJSON stream frame (`stdout` / `stderr` / `event`, then a single terminal `result`). */
export const StreamFrame = Schema.Union([Schema.TaggedStruct("stdout", {
    chunk: Schema.String,
    service: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.String),
  }), Schema.TaggedStruct("stderr", {
    chunk: Schema.String,
    service: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.String),
  }), Schema.TaggedStruct("event", { event: Schema.String, payload: Schema.Unknown }), Schema.TaggedStruct("result", { envelope: CommandResultEnvelope })]);
export type StreamFrame = typeof StreamFrame.Type;

/** Schema type a streaming command declares for its per-line `StreamFrame`s. */
export type StreamFrameSchema = typeof StreamFrame;
