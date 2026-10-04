import { Schema } from "effect";

// ==== Command trace contracts for machine-output --trace envelopes.

const NonNegativeMs = Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const TraceAttributeValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

/** One finished span retained for a command invocation trace. */
export const CommandTraceSpan = Schema.Struct({
  id: Schema.String.annotate({
    description: "Span id, unique within this command trace.",
  }),
  name: Schema.String.annotate({
    description: "Span name. The root is `lando <command-id>`.",
  }),
  parent: Schema.optionalKey(Schema.String).annotate({
    description: "Parent span id. Absent on the root span.",
  }),
  startOffsetMs: NonNegativeMs.annotate({
    description: "Start time in milliseconds relative to the root span.",
  }),
  durationMs: NonNegativeMs.annotate({
    description: "How long the span ran, in milliseconds.",
  }),
  status: Schema.Literals(["ok", "error", "interrupted"]).annotate({
    description: "Span completion status: ok, error, or interrupted.",
  }),
  attributes: Schema.Record(Schema.String, TraceAttributeValue).annotate({
    description: "Redacted key/value attributes retained for this span.",
  }),
}).annotate({
  identifier: "CommandTraceSpan",
  title: "Command Trace Span",
  description: "One finished span in a command-invocation timing tree.",
});
export type CommandTraceSpan = typeof CommandTraceSpan.Type;

/** Timing tree attached to a command result envelope when tracing is enabled. */
export const CommandTrace = Schema.Struct({
  totalDurationMs: NonNegativeMs.annotate({
    description: "Wall time of the root span, in milliseconds.",
  }),
  spans: Schema.Array(CommandTraceSpan).annotate({
    description: "Finished spans retained for this command invocation.",
  }),
  droppedSpans: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "How many finished spans fell off the bounded retention buffer.",
  }),
}).annotate({
  identifier: "CommandTrace",
  title: "Command Trace",
  description: "Command-invocation timing tree for machine-output and display.",
});
export type CommandTrace = typeof CommandTrace.Type;
