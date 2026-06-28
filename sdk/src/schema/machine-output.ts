import { Schema } from "effect";

import { DeprecationUse } from "./deprecation.ts";

/** Command output formats; `json` and `ndjson` are machine-readable, others are human encodings. */
export const CommandResultFormat = Schema.Literal("text", "json", "table", "yaml", "ndjson");
export type CommandResultFormat = typeof CommandResultFormat.Type;

export const CommandWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
});
export type CommandWarning = typeof CommandWarning.Type;

const TaggedErrorJson = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
});

/** JSON envelope for `--format json` (and the terminal `result` stream frame). `apiVersion` changes only on breaking envelope edits. */
export const CommandResultEnvelope = Schema.Struct({
  apiVersion: Schema.Literal("v4"),
  command: Schema.String,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(TaggedErrorJson),
  warnings: Schema.Array(CommandWarning),
  deprecations: Schema.Array(DeprecationUse),
});
export type CommandResultEnvelope = typeof CommandResultEnvelope.Type;

/** One NDJSON stream frame (`stdout` / `stderr` / `event`, then a single terminal `result`). */
export const StreamFrame = Schema.Union(
  Schema.TaggedStruct("stdout", { chunk: Schema.String, service: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("stderr", { chunk: Schema.String, service: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("event", { event: Schema.String, payload: Schema.Unknown }),
  Schema.TaggedStruct("result", { envelope: CommandResultEnvelope }),
);
export type StreamFrame = typeof StreamFrame.Type;

/** Schema type a streaming command declares for its per-line `StreamFrame`s. */
export type StreamFrameSchema = typeof StreamFrame;
