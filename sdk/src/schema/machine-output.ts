import { Schema } from "effect";

import { CommandTrace } from "./command-trace.ts";
import { DeprecationUse } from "./deprecation.ts";
import { FailureRole } from "./failure-role.ts";
export { FailureRole } from "./failure-role.ts";
import { ValidationIssue } from "./validation-issue.ts";

/** Command output formats; `json` and `ndjson` are machine-readable, others are human encodings. */
export const CommandResultFormat = Schema.Literals(["text", "json", "table", "yaml", "ndjson"]);
export type CommandResultFormat = typeof CommandResultFormat.Type;

/** A completed command's semantic verdict, independent of its process status. */
export const CommandCompletion = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true).annotate({ description: "The command completed its intended operation." }),
    exitCode: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Nonnegative shell status, including nonzero findings statuses.",
    }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false).annotate({
      description: "The command did not complete its intended operation.",
    }),
    exitCode: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).annotate({
      description: "Positive shell status for an unsuccessful completion.",
    }),
  }),
]).annotate({ description: "Canonical semantic completion and shell status for a command." });
export type CommandCompletion = typeof CommandCompletion.Type;

export const CommandOutputChunk = Schema.Struct({
  _tag: Schema.Literals(["stdout", "stderr"]).annotate({ description: "Output channel." }),
  chunk: Schema.String.annotate({ description: "Safely decoded and redacted output text." }),
  service: Schema.optionalKey(Schema.String).annotate({ description: "Originating service, when known." }),
  source: Schema.optionalKey(Schema.String).annotate({ description: "Originating source, when known." }),
}).annotate({ description: "One safe command output chunk with optional provenance." });
export type CommandOutputChunk = typeof CommandOutputChunk.Type;

export const CommandOutput = Schema.Struct({
  chunks: Schema.Array(CommandOutputChunk).annotate({ description: "Ordered retained output tail." }),
  truncated: Schema.Boolean.annotate({
    description: "Whether any output was discarded to respect the budget.",
  }),
}).annotate({ description: "Bounded final command output, independent of progress notifications." });
export type CommandOutput = typeof CommandOutput.Type;

export const CommandWarning = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Structured string metadata that identifies the warning source and affected input.",
  }),
});
export type CommandWarning = typeof CommandWarning.Type;

const taggedErrorFields = {
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  service: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        target: Schema.String,
        destructive: Schema.Boolean,
      }),
    ),
  ),
  reason: Schema.optionalKey(Schema.String).annotate({
    description: "Structured failure reason when supplied as a string by the source error.",
  }),
  issues: Schema.optionalKey(Schema.Array(ValidationIssue)).annotate({
    description: "Structured authored-file problems when the failure carries ValidationIssue values.",
  }),
};

const AdditionalErrorJson = Schema.StructWithRest(
  Schema.Struct({
    ...taggedErrorFields,
    role: FailureRole.annotate({
      description: "Why this additional failure occurred: rollback, cleanup, or a peer step.",
    }),
    additionalErrors: Schema.optionalKey(Schema.Never).annotate({
      description: "Additional failures cannot contain a nested additionalErrors property.",
    }),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export const TaggedErrorJson = Schema.StructWithRest(
  Schema.Struct({
    ...taggedErrorFields,
    additionalErrors: Schema.optionalKey(Schema.NonEmptyArray(AdditionalErrorJson)).annotate({
      description:
        "Ordered additional failures after the primary error, excluding interruptions and nested additionalErrors.",
    }),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).annotate({
  description: "Additional keys are the failing tagged error's remaining JSON-safe own fields.",
});

/** JSON envelope for `--format json` (and the terminal `result` stream frame). `apiVersion` changes only on breaking envelope edits. */
export const CommandResultEnvelope = Schema.Struct({
  apiVersion: Schema.Literal("v4"),
  command: Schema.String,
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(CommandOutput).annotate({
    description: "Bounded redacted command output tail.",
  }),
  error: Schema.optionalKey(TaggedErrorJson),
  warnings: Schema.Array(CommandWarning),
  deprecations: Schema.Array(DeprecationUse),
  trace: Schema.optionalKey(CommandTrace).annotate({
    description: "Optional command-invocation timing tree when tracing is enabled.",
  }),
});
export type CommandResultEnvelope = typeof CommandResultEnvelope.Type;

/** One NDJSON stream frame (`stdout` / `stderr` / `event`, then a single terminal `result`). */
export const StreamFrame = Schema.Union([
  Schema.TaggedStruct("stdout", {
    chunk: Schema.String,
    service: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("stderr", {
    chunk: Schema.String,
    service: Schema.optionalKey(Schema.String),
    source: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("event", { event: Schema.String, payload: Schema.Unknown }),
  Schema.TaggedStruct("result", { envelope: CommandResultEnvelope }),
]);
export type StreamFrame = typeof StreamFrame.Type;

/** Schema type a streaming command declares for its per-line `StreamFrame`s. */
export type StreamFrameSchema = typeof StreamFrame;
