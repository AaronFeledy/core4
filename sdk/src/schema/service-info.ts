import { Schema } from "effect";
import { ServiceHomePlan } from "./app-plan.ts";
import { ServiceCredsDisplay } from "./database-connection.ts";
import { EndpointRef } from "./endpoint.ts";
import { HealthcheckPlan } from "./healthcheck-plan.ts";
import { ListenerAuthority } from "./listener.ts";
import { LogSourceStream } from "./log-source.ts";
import { BindMountPlan } from "./mounts.ts";
import { PortablePath, ProjectUserExplanation, ServiceProjectUser } from "./primitives.ts";
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

export const ServiceContainerChange = Schema.Struct({
  action: Schema.Literals(["kept", "started", "replaced", "created"]).annotate({
    description: "What apply did to the service container: kept, started in place, replaced, or created.",
  }),
  reason: Schema.optionalKey(
    Schema.Literals(["reconcile", "config", "publish-port", "bind-source", "network", "host-port"]).annotate({
      description:
        "Why an existing container was replaced: reconcile, create-config drift, published ports, a bind source, a missing network, or a taken host port. Absent for kept, started, and created containers.",
    }),
  ),
  anonymousVolumes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Container paths of a replaced container's anonymous volumes: volumes created by the engine, not by Lando, whose destinations no planned mount of the service covers. A named volume the plan stopped mounting survives the replacement and is not listed.",
  }),
});
export type ServiceContainerChange = typeof ServiceContainerChange.Type;

export const StartedService = Schema.Struct({
  name: Schema.String.annotate({ description: "Service name in the app plan." }),
  state: ServiceState.annotate({
    description: "Observed service state after startup or readiness supervision.",
  }),
  container: Schema.optionalKey(ServiceContainerChange).annotate({
    description: "What apply did to this service's container; absent when the provider does not report it.",
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

const ServiceInfoProbe = Schema.Struct({
  kind: HealthcheckPlan.fields.kind.annotate({ description: "Configured probe kind." }),
  intervalSeconds: HealthcheckPlan.fields.intervalSeconds,
  timeoutSeconds: HealthcheckPlan.fields.timeoutSeconds,
  retries: HealthcheckPlan.fields.retries,
  startPeriodSeconds: HealthcheckPlan.fields.startPeriodSeconds,
  target: Schema.Literals(["service", "host"]).annotate({ description: "Probe execution location." }),
  user: Schema.optionalKey(Schema.String).annotate({ description: "Known container execution identity." }),
  userSource: Schema.Literals(["probe", "service", "image", "cli"]).annotate({
    description: "Whether identity comes from the probe, service, image default, or invoking CLI.",
  }),
  listener: Schema.optionalKey(EndpointRef).annotate({
    description: "Declared listener identity, not execution location.",
  }),
  commandConfigured: Schema.Boolean.annotate({
    description: "Whether an enabled command is configured; command text is never exposed.",
  }),
  configPath: Schema.Array(Schema.String).annotate({
    description: "Landofile field where this policy can be configured.",
  }),
});

const ServiceInfoHealth = Schema.Struct({
  check: Schema.optionalKey(ServiceInfoProbe),
  state: Schema.Literals(["not-monitored", "unknown", "starting", "healthy", "unhealthy"]).annotate({
    description: "Provider-observed native health, or explicit lack of monitoring/evidence.",
  }),
});

const ServiceInfoReadiness = Schema.Struct({
  check: Schema.optionalKey(ServiceInfoProbe),
  state: Schema.Literals(["disabled", "not-configured", "not-observed"]).annotate({
    description: "Lifecycle policy state; info never reruns probes or invents readiness evidence.",
  }),
  source: Schema.Literals(["authored", "contributed", "healthcheck", "unknown", "none"]).annotate({
    description: "Recorded readiness provenance, native fallback, or absent/unknown provenance.",
  }),
});

export const ServiceInfo = Schema.Struct({
  listenerAuthority: Schema.optionalKey(ListenerAuthority).annotate({
    description: "Planned listener ownership and configuration advice, without claiming an observation.",
  }),
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
  projectUser: Schema.optionalKey(ServiceProjectUser).annotate({
    description: "Realized project-user identity whose files belong to the host user.",
  }),
  projectUserExplanation: Schema.optionalKey(ProjectUserExplanation).annotate({
    description: "Why the service has no realized project user.",
  }),
  workingDirectory: Schema.optionalKey(PortablePath).annotate({
    description: "Planned working directory inside the service.",
  }),
  hostnames: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Canonical deduplicated network aliases for this service.",
  }),
  certs: Schema.optionalKey(
    Schema.Struct({ state: Schema.Literals(["none", "generated", "custom"]) }),
  ).annotate({
    description:
      "Planned certificate source; generated means Lando issues and maintains the certificate when applying the service.",
  }),
  health: Schema.optionalKey(ServiceInfoHealth).annotate({
    description: "Safe configured native health policy and provider-reported health state.",
  }),
  readiness: Schema.optionalKey(ServiceInfoReadiness).annotate({
    description:
      "Safe effective lifecycle readiness policy, without claiming a current or retained readiness observation.",
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

// ============================================================================
// Decode-only cross-field consistency of `status` and `health.state`.
// ============================================================================

const NATIVE_HEALTH_STATES: ReadonlySet<string> = new Set(["starting", "healthy", "unhealthy"]);
const LIVE_SERVICE_STATES: ReadonlySet<string> = new Set([
  "running",
  "starting",
  "healthy",
  "unhealthy",
  "ready",
]);

/**
 * `ServiceInfo` plus the rule that its `status` and `health.state` describe one observation: a
 * provider-reported health verdict exists only for a live container, and a `healthy`/`unhealthy`
 * status cannot contradict the native verdict. Used when constructing info results and decoding
 * external values; kept outside the registry so the published struct stays snapshot-stable.
 */
export const ServiceInfoConsistent = ServiceInfo.pipe(
  Schema.check(
    Schema.makeFilter((info: ServiceInfo) => {
      const native = info.health?.state;
      if (native === undefined || !NATIVE_HEALTH_STATES.has(native)) return undefined;
      if (!LIVE_SERVICE_STATES.has(info.status))
        return `health.state "${native}" requires a live status, found "${info.status}"`;
      if (NATIVE_HEALTH_STATES.has(info.status) && native !== info.status) {
        return `status "${info.status}" contradicts health.state "${native}"`;
      }
      if (info.status === "ready" && native !== "healthy") {
        return `status "ready" contradicts health.state "${native}"`;
      }
      return undefined;
    }),
  ),
);
