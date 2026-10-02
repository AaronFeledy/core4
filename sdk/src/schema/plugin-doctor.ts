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

// ====
// Bounded doctor-check context ports: app identity, resource names, executable location.

const DoctorBoundedText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096));

/**
 * Identity of the app the doctor run was started in. Only the app name and its
 * canonical root are exposed; checks never receive the Landofile itself.
 */
export const DoctorAppIdentity = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)).annotations({
    description: "App name as authored in the Landofile.",
  }),
  root: DoctorBoundedText.annotations({ description: "Absolute canonical app root." }),
});
export type DoctorAppIdentity = typeof DoctorAppIdentity.Type;

/** Most names one resource query may return. */
export const DOCTOR_RESOURCE_QUERY_MAX_LIMIT = 64;

/**
 * One bounded name/label query against the selected provider. A query matches
 * by name prefix, by one exact label, or both; resources Lando 4 owns are never
 * returned.
 */
export const DoctorResourceNameQuery = Schema.Struct({
  kind: Schema.Literal("volume", "container").annotations({
    description: "Resource kind to inspect.",
  }),
  namePrefix: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))).annotations({
    description: "Case-sensitive resource name prefix.",
  }),
  label: Schema.optional(
    Schema.Struct({
      key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
      value: Schema.String.pipe(Schema.maxLength(4_096)),
    }),
  ).annotations({ description: "Exact label key/value match." }),
  limit: Schema.Int.pipe(Schema.between(1, DOCTOR_RESOURCE_QUERY_MAX_LIMIT)).annotations({
    description: "Maximum number of names returned.",
  }),
});
export type DoctorResourceNameQuery = typeof DoctorResourceNameQuery.Type;

/**
 * Outcome of one resource query. `unsupported` means the selected provider has
 * no bounded inspector; `unavailable` means the query could not complete.
 */
export const DoctorResourceInspection = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("ok"),
    names: Schema.Array(Schema.String.pipe(Schema.maxLength(256))).pipe(
      Schema.maxItems(DOCTOR_RESOURCE_QUERY_MAX_LIMIT),
    ),
    truncated: Schema.Boolean.annotations({
      description: "True when the result reached the query limit, so more names may exist.",
    }),
  }),
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: PluginDoctorMessage }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: PluginDoctorMessage }),
);
export type DoctorResourceInspection = typeof DoctorResourceInspection.Type;

/**
 * Filesystem/PATH-only location of the running executable and a named PATH
 * candidate. Nothing here comes from executing or reading a candidate.
 * `runningBasename` is `lando4` for both `lando4` and case-insensitive Windows
 * `lando4.exe`; any other name is reported as-is.
 */
export const DoctorExecutableLocation = Schema.Struct({
  runningBasename: Schema.String.pipe(Schema.maxLength(256)),
  runningPath: Schema.optional(DoctorBoundedText),
  candidate: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("found"), path: DoctorBoundedText }),
    Schema.Struct({ kind: Schema.Literal("missing") }),
    Schema.Struct({ kind: Schema.Literal("ambiguous"), reason: PluginDoctorMessage }),
  ),
});
export type DoctorExecutableLocation = typeof DoctorExecutableLocation.Type;
