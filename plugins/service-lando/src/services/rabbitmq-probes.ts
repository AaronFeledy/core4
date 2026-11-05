import type { HealthcheckPlan } from "@lando/sdk/schema";
import { tcpProbe, tcpThenProbe } from "./_tcp-probe.ts";

export const rabbitmqProbes = (
  port: number,
): { readonly healthcheck: HealthcheckPlan; readonly readiness: HealthcheckPlan } => {
  return {
    healthcheck: tcpProbe(port, 30),
    readiness: tcpThenProbe(port, ["rabbitmq-diagnostics", "-q", "ping"], 30),
  };
};
