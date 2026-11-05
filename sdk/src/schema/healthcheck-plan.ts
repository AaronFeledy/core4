import { Schema } from "effect";
import { EndpointRef } from "./endpoint.ts";
import { CommandSpec, ContainerUser } from "./primitives.ts";
import { ProbeIntervalSeconds, ProbeRetries, ProbeTimeoutSeconds } from "./probe-timing.ts";

// ============================================================================
// Startup and ongoing service probe contracts.
// ============================================================================

export const HealthcheckPlan = Schema.Struct({
  executionTarget: Schema.optionalKey(Schema.Literals(["service", "host"])).annotate({
    description:
      "Probe execution location; omitted means service. Host is the CLI machine, not a provider VM.",
  }),
  user: Schema.optionalKey(ContainerUser).annotate({
    description: "Exact container user for a service probe; host probes cannot select a user.",
  }),
  kind: Schema.Literals(["command", "http", "tcp", "none"]),
  command: Schema.optionalKey(CommandSpec),
  target: Schema.optionalKey(EndpointRef).annotate({
    description:
      "Declared command-probe listener, identified by port and transport; supplied through LANDO_PROBE_HOST and LANDO_PROBE_PORT.",
  }),
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  intervalSeconds: ProbeIntervalSeconds,
  timeoutSeconds: ProbeTimeoutSeconds,
  retries: ProbeRetries.annotate({
    description:
      "Maximum attempts after the start period, with at least one attempt; the first success completes the probe.",
  }),
  startPeriodSeconds: Schema.optionalKey(ProbeIntervalSeconds).annotate({
    description:
      "Grace period in seconds: probing starts immediately, but failures during this period do not consume retries.",
  }),
});
export type HealthcheckPlan = typeof HealthcheckPlan.Type;
