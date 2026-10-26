import { Schema } from "effect";
import { ServiceHomePlan } from "./app-plan.ts";

import { ServiceCredsDisplay } from "./database-connection.ts";
import { AppMountPlan } from "./mounts.ts";
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

export const ServiceInfoLogSource = Schema.Struct({
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
export type ServiceInfoLogSource = typeof ServiceInfoLogSource.Type;

export const StartedService = Schema.Struct({
  name: Schema.String.annotate({ description: "Service name in the app plan." }),
  state: ServiceState.annotate({
    description: "Observed service state after startup or readiness supervision.",
  }),
  ...connectionAddressFields,
});
export type StartedService = typeof StartedService.Type;

export const ServiceInfo = Schema.Struct({
  app: Schema.String,
  service: Schema.String,
  api: Schema.Literal(4),
  type: Schema.String,
  provider: Schema.String,
  primary: Schema.Boolean,
  home: Schema.optionalKey(ServiceHomePlan).annotate({
    description: "Planned service home persistence status.",
  }),
  status: ServiceState.annotate({ description: "Latest observed or supervised service state." }),
  ...connectionAddressFields,
  logSources: Schema.optionalKey(Schema.Array(ServiceInfoLogSource)).annotate({
    description: "Declared service log sources and their provider-specific availability.",
  }),
  mounts: Schema.optionalKey(Schema.Array(ServiceInfoMount)).annotate({
    description: "Planned and runtime user mounts with explicit observation and storage lifetime evidence.",
  }),
  appMount: Schema.optionalKey(AppMountPlan).annotate({
    description: "Full resolved application source mount, absent when disabled.",
  }),
  creds: Schema.optionalKey(ServiceCredsDisplay).annotate({
    description: "Service login credentials surfaced by `lando info` when the service publishes them.",
  }),
});
export type ServiceInfo = typeof ServiceInfo.Type;
