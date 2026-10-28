import { Schema } from "effect";

export const FileSyncPolicyReason = Schema.Literals([
  "explicit-engine",
  "default-engine",
  "sole-engine",
  "native-provider",
  "global-passthrough",
  "no-compatible-engine",
  "absent-app-mount",
  "service-opt-out",
  "unknown",
]);
export type FileSyncPolicyReason = typeof FileSyncPolicyReason.Type;

export const FileSyncServicePolicy = Schema.Struct({
  mode: Schema.Literals(["ordinary", "accelerated", "absent"]).annotate({
    description: "Planned service project-file realization.",
  }),
  reason: FileSyncPolicyReason.annotate({ description: "Recorded reason for this service realization." }),
});
export type FileSyncServicePolicy = typeof FileSyncServicePolicy.Type;

export const FileSyncPolicy = Schema.Struct({
  engineId: Schema.optionalKey(Schema.String).annotate({
    description: "Single selected engine, absent for ordinary plans.",
  }),
  reason: FileSyncPolicyReason.annotate({ description: "Recorded application selection reason." }),
  services: Schema.Record(Schema.String, FileSyncServicePolicy).annotate({
    description: "Project-file policy for every planned service.",
  }),
});
export type FileSyncPolicy = typeof FileSyncPolicy.Type;

export const FileSyncPolicyInfo = Schema.Struct({
  mode: Schema.Literals(["ordinary", "accelerated", "unknown"]).annotate({
    description: "Recorded plan realization, not observed daemon health.",
  }),
  engineId: Schema.optionalKey(Schema.String).annotate({
    description: "Verified single engine id, shown once at app level.",
  }),
  reason: FileSyncPolicyReason.annotate({
    description: "Recorded reason, or unknown for absent or contradictory metadata.",
  }),
  services: Schema.Array(
    Schema.Struct({
      service: Schema.String.annotate({ description: "Service name." }),
      mode: Schema.Literals(["ordinary", "accelerated", "absent", "unknown"]).annotate({
        description: "Project-file realization verified against mount and session facts.",
      }),
      reason: FileSyncPolicyReason.annotate({
        description: "Recorded per-service policy reason, never inferred from current config.",
      }),
      exclusions: Schema.Struct({
        kind: Schema.Literals(["transport-patterns", "directory-overlays", "none", "unknown"]).annotate({
          description: "Exclusion mechanism, not a claim that an engine is running.",
        }),
        patterns: Schema.Array(Schema.String).annotate({
          description: "Exact planned transport filters; empty for ordinary binds.",
        }),
        overlays: Schema.Array(Schema.String).annotate({
          description: "Derived directory-overlay container paths.",
        }),
      }).annotate({ description: "Transport filtering and ordinary directory overlays are distinct." }),
      hostBackedIncludes: Schema.Array(
        Schema.Struct({
          source: Schema.String.annotate({ description: "Host-backed included path." }),
          target: Schema.String.annotate({ description: "Included container path." }),
        }),
      ).annotate({ description: "Paths reopened or retained on the host by explicit includes." }),
    }),
  ).annotate({ description: "Per-service policy projection without repeated engine ids." }),
});
export type FileSyncPolicyInfo = typeof FileSyncPolicyInfo.Type;

export const FileSyncInfo = Schema.Struct({
  planned: Schema.optionalKey(FileSyncPolicyInfo).annotate({
    description: "Desired plan policy, absent when unavailable.",
  }),
  applied: Schema.optionalKey(FileSyncPolicyInfo).annotate({
    description: "Recorded applied-plan policy, absent without applied evidence.",
  }),
  pendingChange: Schema.Boolean.annotate({
    description: "Known planned and applied policies differ; not daemon state.",
  }),
});
export type FileSyncInfo = typeof FileSyncInfo.Type;
