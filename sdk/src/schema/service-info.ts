import { Schema } from "effect";
import { ServiceHomePlan } from "./app-plan.ts";
import { PortablePath } from "./primitives.ts";

import { ServiceCredsDisplay } from "./database-connection.ts";
import { LogSourceStream } from "./log-source.ts";
import { BindMountPlan } from "./mounts.ts";
import { ServiceConnection, ServiceState } from "./service-connection.ts";
import { ServiceInfoMount } from "./service-mount.ts";

// ============================================================================
// Provider-neutral connection addresses and runtime service metadata.
// ============================================================================

const connectionAddressFields = {
  connections: Schema.Array(ServiceConnection).annotate({
    description: "Configured scoped connections with explicit binding and observation state.",
  }),
};

const FileServiceInfoLogSource = Schema.Struct({
  id: Schema.String.annotate({ description: "Declared log source identifier." }),
  path: Schema.String.annotate({ description: "Log file path inside the service." }),
  strategy: Schema.Literals(["redirect", "follow"]).annotate({
    description: "How the log source is collected.",
  }),
  availability: Schema.Literals(["available", "redirected-to-console", "unavailable"]).annotate({
    description: "Whether this provider can expose the source or redirects it to console logs.",
  }),
  reason: Schema.optionalKey(Schema.String).annotate({ description: "Reason the source is unavailable." }),
});
export const ServiceInfoLogSource = Schema.Union([
  FileServiceInfoLogSource,
  Schema.Struct({
    id: FileServiceInfoLogSource.fields.id,
    strategy: Schema.Literal("console").annotate({ description: "A native console pipe alias." }),
    stream: LogSourceStream.annotate({ description: "Native daemon pipe selected by this alias." }),
    path: Schema.optionalKey(Schema.Never),
    availability: Schema.Literals(["available", "unavailable"]).annotate({
      description: "Whether this provider can stream native service logs.",
    }),
    reason: FileServiceInfoLogSource.fields.reason,
  }),
]);
export type ServiceInfoLogSource = typeof ServiceInfoLogSource.Type;

export const StartedService = Schema.Struct({
  name: Schema.String.annotate({ description: "Service name in the app plan." }),
  state: ServiceState.annotate({
    description: "Observed service state after startup or readiness supervision.",
  }),
  ...connectionAddressFields,
});
export type StartedService = typeof StartedService.Type;

const ServiceInfoArtifact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ref"),
    ref: Schema.String,
    digest: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("build"), contentHash: Schema.optionalKey(Schema.String) }),
]);

const ServiceInfoHealth = Schema.Struct({
  check: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(["command", "http", "tcp", "none"]),
      intervalSeconds: Schema.Number,
      timeoutSeconds: Schema.Number,
      retries: Schema.Number,
      startPeriodSeconds: Schema.optionalKey(Schema.Number),
    }),
  ),
  state: Schema.Literals(["unknown", "starting", "healthy", "unhealthy"]),
});

export const ServiceInfo = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  status: ServiceState.annotate({ description: "Latest observed or supervised service state." }),
  artifact: Schema.optionalKey(ServiceInfoArtifact).annotate({
    description: "Selected artifact identity without build context, arguments, or inline source.",
  }),
  user: Schema.optionalKey(Schema.String).annotate({ description: "Planned container user." }),
  workingDirectory: Schema.optionalKey(PortablePath).annotate({
    description: "Planned working directory inside the service.",
  }),
  hostnames: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Canonical deduplicated network aliases for this service.",
  }),
  certs: Schema.optionalKey(
    Schema.Struct({ state: Schema.Literals(["none", "generated", "custom"]) }),
  ).annotate({
    description: "Planned certificate source, when the plan records it.",
  }),
  health: Schema.optionalKey(ServiceInfoHealth).annotate({
    description: "Safe planned probe settings and provider-reported health state.",
  }),
  providerInfo: Schema.optionalKey(Schema.Json).annotate({
    description: "Reserved JSON-safe provider-specific details, when explicitly supplied.",
  }),
  ...connectionAddressFields,
  logSources: Schema.optionalKey(Schema.Array(ServiceInfoLogSource)).annotate({
    description: "Declared service log sources and their provider-specific availability.",
  }),
  mounts: Schema.optionalKey(Schema.Array(ServiceInfoMount)).annotate({
    description: "Planned and runtime user mounts with explicit observation and storage lifetime evidence.",
  }),
  appMount: Schema.optionalKey(BindMountPlan).annotate({
    description: "Full resolved application source mount, absent when disabled.",
  }),
  home: Schema.optionalKey(ServiceHomePlan).annotate({
    description: "Planned service home persistence status.",
  }),
  creds: Schema.optionalKey(ServiceCredsDisplay).annotate({
    description: "Service login credentials surfaced by `lando info` when the service publishes them.",
  }),
});
export type ServiceInfo = typeof ServiceInfo.Type;
