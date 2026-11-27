import { Schema } from "effect";

import { PortablePath } from "./primitives.ts";

export const ServiceDataVersionRecord = Schema.Struct({
  path: PortablePath.annotate({ description: "Container path to the database version record." }),
  pattern: Schema.String.annotate({ description: "Regular expression whose first capture is a version." }),
});
export type ServiceDataVersionRecord = typeof ServiceDataVersionRecord.Type;

export const ServiceDataVersionRefusal = Schema.Struct({
  pattern: Schema.String.annotate({ description: "Regular expression matched against a single log line." }),
  exitCodes: Schema.optionalKey(Schema.Array(Schema.Int)).annotate({
    description: "Exit codes required for this diagnostic to count as a refusal.",
  }),
  direction: Schema.Literals(["downgrade", "upgrade", "incompatible", "compare"]).annotate({
    description: "Refusal direction, or compare to determine it from captured versions.",
  }),
  hint: Schema.optionalKey(Schema.String).annotate({ description: "Product-specific recovery advice." }),
});
export type ServiceDataVersionRefusal = typeof ServiceDataVersionRefusal.Type;

export const ServiceDataVersion = Schema.Struct({
  target: PortablePath.annotate({ description: "Mount target of the database's persisted data." }),
  label: Schema.String.annotate({ description: "Database product name for diagnostics." }),
  series: Schema.optionalKey(
    Schema.Struct({
      image: Schema.optionalKey(Schema.String).annotate({
        description: "Known version series selected by the planned image.",
      }),
      depth: Schema.Literals([1, 2]).annotate({ description: "Number of significant version components." }),
      records: Schema.Array(ServiceDataVersionRecord).annotate({ description: "On-disk version records." }),
      upgrade: Schema.Literals(["in-place", "unsupported"]).annotate({
        description: "Whether this server type can upgrade existing storage in place.",
      }),
    }),
  ).annotate({ description: "Evidence and policy for comparing versions before activation." }),
  refusals: Schema.Array(ServiceDataVersionRefusal).annotate({ description: "Native startup refusals." }),
});
export type ServiceDataVersion = typeof ServiceDataVersion.Type;

export const ServiceDataVersionFinding = Schema.Struct({
  direction: Schema.Literals(["downgrade", "upgrade", "incompatible"]).annotate({
    description: "Kind of incompatible version change.",
  }),
  dataVersion: Schema.optionalKey(Schema.String).annotate({ description: "Version observed on storage." }),
  imageVersion: Schema.optionalKey(Schema.String).annotate({
    description: "Version of the selected server.",
  }),
  evidence: Schema.Literals(["record", "running-image", "guard", "server"]).annotate({
    description: "Source that established the refusal.",
  }),
});
export type ServiceDataVersionFinding = typeof ServiceDataVersionFinding.Type;

export const DATA_VERSION_REFUSAL_MARKER = "lando-data-version-refused";
