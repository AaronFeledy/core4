import { Schema } from "effect";

// =============================================================================
// Attached host terminal facts
// =============================================================================

/** Facts borrowed from an output terminal that core has positively identified as attached. */
export const HostTerminal = Schema.Struct({
  term: Schema.optional(Schema.NonEmptyString).annotations({
    description: "Attached terminal's TERM value, copied verbatim when present.",
  }),
  colorterm: Schema.optional(Schema.NonEmptyString).annotations({
    description: "Attached terminal's COLORTERM value, copied verbatim when present.",
  }),
  columns: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())).annotations({
    description: "Attached terminal width in columns.",
  }),
  rows: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())).annotations({
    description: "Attached terminal height in rows.",
  }),
}).annotations({
  identifier: "HostTerminal",
  description: "Capabilities observed from an output terminal that is actually attached to the host process.",
});

export type HostTerminal = typeof HostTerminal.Type;
