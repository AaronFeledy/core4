import { Schema } from "effect";
import { EndpointRef } from "./endpoint.ts";
import { CommandSpec } from "./primitives.ts";

// ============================================================================
// Startup and ongoing service probe contracts.
// ============================================================================

export const HealthcheckPlan = Schema.Struct({
  kind: Schema.Literals(["command", "http", "tcp", "none"]),
  command: Schema.optionalKey(CommandSpec),
  target: Schema.optionalKey(EndpointRef).annotate({
    description:
      "Declared command-probe listener, identified by port and transport; supplied through LANDO_PROBE_HOST and LANDO_PROBE_PORT.",
  }),
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  intervalSeconds: Schema.Number,
  timeoutSeconds: Schema.Number,
  retries: Schema.Number.annotate({
    description:
      "Maximum attempts after the start period, with at least one attempt; the first success completes the probe.",
  }),
  startPeriodSeconds: Schema.optionalKey(Schema.Number).annotate({
    description:
      "Grace period in seconds: probing starts immediately, but failures during this period do not consume retries.",
  }),
});
export type HealthcheckPlan = typeof HealthcheckPlan.Type;
