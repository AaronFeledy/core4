import { Schema } from "effect";

// ====
// Plugin-contributed doctor report payloads.

const PluginDoctorName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const PluginDoctorMessage = Schema.String.pipe(Schema.maxLength(2_000));
const PluginDoctorContextKey = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const PluginDoctorContext = Schema.Record({
  key: PluginDoctorContextKey,
  value: PluginDoctorMessage,
}).pipe(
  Schema.filter(
    (context) =>
      Object.keys(context).length <= 32 &&
      Object.values(context).reduce((length, value) => length + value.length, 0) <= 16_000,
    {
      message: () =>
        "PluginDoctorReport.context must contain at most 32 entries and 16000 total value characters",
    },
  ),
  Schema.annotations({ jsonSchema: { maxProperties: 32 } }),
);

const PluginDoctorSolution = Schema.Struct({
  kind: Schema.Literal("automatic", "manual").annotations({
    description: "Whether the remediation can be automated or requires manual action.",
  }),
  description: PluginDoctorMessage.annotations({
    description: "Redaction-aware remediation text, limited to 2,000 characters.",
  }),
  command: Schema.optional(PluginDoctorMessage).annotations({
    description: "Optional remediation command, limited to 2,000 characters.",
  }),
});

/**
 * One plugin-authored doctor result. Core strictly decodes, redacts every
 * string, and decodes again before report inclusion; invalid contributions are
 * dropped. Names and context keys are limited to 128 characters; message-like
 * strings to 2,000; context to 32 entries/16,000 value characters; and
 * solutions to 16 entries.
 */
export const PluginDoctorReport = Schema.Struct({
  name: PluginDoctorName.annotations({
    description: "Plugin-local check name, limited to 128 characters.",
  }),
  status: Schema.Literal("pass", "warn", "fail").annotations({
    description: "Check outcome used by doctor summaries and exit status.",
  }),
  severity: Schema.Literal("info", "warn", "error").annotations({
    description: "Diagnostic severity associated with the check outcome.",
  }),
  runtimeStatus: Schema.optional(PluginDoctorMessage).annotations({
    description: "Optional human-readable runtime status, limited to 2,000 characters.",
  }),
  runtime: Schema.optional(
    Schema.Struct({
      running: Schema.Boolean.annotations({
        description: "Whether the checked runtime is currently running.",
      }),
      version: Schema.optional(Schema.String.pipe(Schema.maxLength(256))).annotations({
        description: "Optional runtime version, limited to 256 characters.",
      }),
    }),
  ).annotations({ description: "Optional structured runtime state." }),
  context: PluginDoctorContext.annotations({
    description:
      "Diagnostic context with at most 32 entries, 128-character keys, 2,000-character values, and 16,000 total value characters.",
  }),
  solutions: Schema.Array(PluginDoctorSolution).pipe(Schema.maxItems(16)).annotations({
    description: "Zero to 16 remediation options for the reported condition.",
  }),
  preempts: Schema.optional(Schema.Boolean).annotations({
    description: "Whether this report prevents provider construction and supersedes later checks.",
  }),
});
export type PluginDoctorReport = typeof PluginDoctorReport.Type;
