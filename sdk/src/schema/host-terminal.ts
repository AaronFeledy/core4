import { Schema } from "effect";

// =============================================================================
// Attached host terminal facts
// =============================================================================

/** Facts borrowed from an output terminal that core has positively identified as attached. */
export const HostTerminal = Schema.Struct({
  term: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "Attached terminal's TERM value, copied verbatim when present.",
  }),
  colorterm: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "Attached terminal's COLORTERM value, copied verbatim when present.",
  }),
  columns: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)))).annotate({
    description: "Attached terminal width in columns.",
  }),
  rows: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)))).annotate({
    description: "Attached terminal height in rows.",
  }),
}).annotate({
  identifier: "HostTerminal",
  description: "Capabilities observed from an output terminal that is actually attached to the host process.",
});

export type HostTerminal = typeof HostTerminal.Type;
