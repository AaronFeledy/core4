import { Schema } from "effect";

// ====
// Plugin-contributed doctor report payloads.

const PluginDoctorName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);
const PluginDoctorMessage = Schema.String.pipe(Schema.check(Schema.isMaxLength(2_000)));
const PluginDoctorContextKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);
const PluginDoctorContext = Schema.Record(PluginDoctorContextKey, PluginDoctorMessage).pipe(
  Schema.check(
    Schema.makeFilter(
      (context) =>
        Object.keys(context).length <= 32 &&
        Object.values(context).reduce((length, value) => length + value.length, 0) <= 16_000,
      {
        message:
          "PluginDoctorReport.context must contain at most 32 entries and 16000 total value characters",
      },
    ),
  ),
  Schema.annotate({ jsonSchema: { maxProperties: 32 } }),
);

const PluginDoctorSolution = Schema.Struct({
  kind: Schema.Literals(["automatic", "manual"]).annotate({
    description: "Whether the remediation can be automated or requires manual action.",
  }),
  description: PluginDoctorMessage.annotate({
    description: "Redaction-aware remediation text, limited to 2,000 characters.",
  }),
  command: Schema.optionalKey(PluginDoctorMessage).annotate({
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
  name: PluginDoctorName.annotate({
    description: "Plugin-local check name, limited to 128 characters.",
  }),
  status: Schema.Literals(["pass", "warn", "fail"]).annotate({
    description: "Check outcome used by doctor summaries and exit status.",
  }),
  severity: Schema.Literals(["info", "warn", "error"]).annotate({
    description: "Diagnostic severity associated with the check outcome.",
  }),
  runtimeStatus: Schema.optionalKey(PluginDoctorMessage).annotate({
    description: "Optional human-readable runtime status, limited to 2,000 characters.",
  }),
  runtime: Schema.optionalKey(
    Schema.Struct({
      running: Schema.Boolean.annotate({
        description: "Whether the checked runtime is currently running.",
      }),
      version: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(256)))).annotate({
        description: "Optional runtime version, limited to 256 characters.",
      }),
    }),
  ).annotate({ description: "Optional structured runtime state." }),
  context: PluginDoctorContext.annotate({
    description:
      "Diagnostic context with at most 32 entries, 128-character keys, 2,000-character values, and 16,000 total value characters.",
  }),
  solutions: Schema.Array(PluginDoctorSolution)
    .pipe(Schema.check(Schema.isMaxLength(16)))
    .annotate({
      description: "Zero to 16 remediation options for the reported condition.",
    }),
  preempts: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether this report prevents provider construction and supersedes later checks.",
  }),
});
export type PluginDoctorReport = typeof PluginDoctorReport.Type;

// ====
// Bounded doctor-check context ports: app identity, resource names, executable location.

const DoctorBoundedText = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
);

/**
 * Identity of the app the doctor run was started in. Only the app name and its
 * canonical root are exposed; checks never receive the Landofile itself.
 */
export const DoctorAppIdentity = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(256)),
  ).annotate({
    description: "App name as authored in the Landofile.",
  }),
  root: DoctorBoundedText.annotate({ description: "Absolute canonical app root." }),
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
  kind: Schema.Literals(["volume", "container"]).annotate({
    description: "Resource kind to inspect.",
  }),
  namePrefix: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256))),
  ).annotate({
    description: "Case-sensitive resource name prefix.",
  }),
  label: Schema.optionalKey(
    Schema.Struct({
      key: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256))),
      value: Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096))),
    }),
  ).annotate({ description: "Exact label key/value match." }),
  limit: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 1, maximum: DOCTOR_RESOURCE_QUERY_MAX_LIMIT })),
  ).annotate({
    description: "Maximum number of names returned.",
  }),
});
export type DoctorResourceNameQuery = typeof DoctorResourceNameQuery.Type;

/**
 * Outcome of one resource query. `unsupported` means the selected provider has
 * no bounded inspector; `unavailable` means the query could not complete.
 */
export const DoctorResourceInspection = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    names: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(256)))).pipe(
      Schema.check(Schema.isMaxLength(DOCTOR_RESOURCE_QUERY_MAX_LIMIT)),
    ),
    truncated: Schema.Boolean.annotate({
      description: "True when the result reached the query limit, so more names may exist.",
    }),
  }),
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: PluginDoctorMessage }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: PluginDoctorMessage }),
]);
export type DoctorResourceInspection = typeof DoctorResourceInspection.Type;

/**
 * Filesystem/PATH-only location of the running executable and a named PATH
 * candidate. Nothing here comes from executing or reading a candidate.
 * `runningBasename` is `lando4` for both `lando4` and case-insensitive Windows
 * `lando4.exe`; any other name is reported as-is.
 */
export const DoctorExecutableLocation = Schema.Struct({
  runningBasename: Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
  runningPath: Schema.optionalKey(DoctorBoundedText),
  candidate: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("found"), path: DoctorBoundedText }),
    Schema.Struct({ kind: Schema.Literal("missing") }),
    Schema.Struct({ kind: Schema.Literal("ambiguous"), reason: PluginDoctorMessage }),
  ]),
});
export type DoctorExecutableLocation = typeof DoctorExecutableLocation.Type;
