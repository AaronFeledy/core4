import { Schema } from "effect";

import { DeprecationUse } from "./deprecation.ts";

/**
 * Output formats a command can render. `json` is the universal machine-output
 * tenet guarantee; `ndjson` is the streaming variant; `text`/`table`/`yaml`
 * are human encodings that individual commands MAY opt into.
 */
export const CommandResultFormat = Schema.Literal("text", "json", "table", "yaml", "ndjson");
export type CommandResultFormat = typeof CommandResultFormat.Type;

/**
 * A non-fatal advisory attached to a command result envelope.
 */
export const CommandWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
});
export type CommandWarning = typeof CommandWarning.Type;

/**
 * The machine-readable JSON shape of a tagged error, as carried in a failing
 * command result envelope. Every Lando tagged error encodes to at least a
 * machine `_tag` and a human `message`, with optional remediation guidance.
 */
const TaggedErrorJson = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
});

/**
 * The single envelope emitted by every `--format json` command invocation
 * (streaming commands terminate their frames with a `result` frame carrying
 * this envelope). `apiVersion` bumps only on a breaking envelope change; the
 * per-command `result` shape is typed by that command's `resultSchema` and
 * frozen by the schema snapshot.
 */
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

/**
 * A newline-delimited frame emitted by a streaming command under
 * `--format json`. A stream is a sequence of `stdout`/`stderr`/`event` frames
 * terminated by exactly one `result` frame carrying the envelope.
 */
export const StreamFrame = Schema.Union(
  Schema.TaggedStruct("stdout", { chunk: Schema.String, service: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("stderr", { chunk: Schema.String, service: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("event", { event: Schema.String, payload: Schema.Unknown }),
  Schema.TaggedStruct("result", { envelope: CommandResultEnvelope }),
);
export type StreamFrame = typeof StreamFrame.Type;
