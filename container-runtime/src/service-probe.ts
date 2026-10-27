import {
  type AppPlan,
  type HealthcheckPlan,
  type ServicePlan,
  serviceListenerTarget,
} from "@lando/sdk/schema";
import { Result } from "effect";
import { ContainerPlanError } from "./container-plan-error.ts";

export const compileServiceProbe = (
  probe: HealthcheckPlan,
  plan?: Pick<AppPlan, "slug" | "networking">,
  service?: Pick<ServicePlan, "name" | "endpoints">,
): readonly string[] | undefined => {
  if (probe.kind !== "command" || probe.command === undefined) return undefined;
  const command = typeof probe.command === "string" ? ["sh", "-c", probe.command] : [...probe.command];
  if (probe.target === undefined) return command;
  if (plan === undefined || service === undefined)
    throw new ContainerPlanError("Targeted probes require their application and service plan.");
  const target = serviceListenerTarget(plan, service, probe.target);
  if (Result.isFailure(target)) throw new ContainerPlanError(target.failure.message);
  return [
    "env",
    `LANDO_PROBE_HOST=${target.success.host}`,
    `LANDO_PROBE_PORT=${target.success.port}`,
    ...command,
  ];
};
