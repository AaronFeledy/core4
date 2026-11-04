import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { containerHealthcheck } from "../create-values.ts";

export const composeHealthcheck = (plan: AppPlan, service: ServicePlan): readonly string[] => {
  const check = containerHealthcheck(service.healthcheck, plan, service);
  if (check === undefined) return [];
  const lines = [
    "    healthcheck:",
    "      test:",
    ...check.Test.map((arg) => `        - ${quoteYamlScalar(arg.replaceAll("$", "$$"))}`),
  ];
  if ("Interval" in check) {
    lines.push(
      `      interval: ${quoteYamlScalar(`${check.Interval}ns`)}`,
      `      timeout: ${quoteYamlScalar(`${check.Timeout}ns`)}`,
      `      retries: ${check.Retries}`,
    );
    if (check.StartPeriod !== undefined)
      lines.push(`      start_period: ${quoteYamlScalar(`${check.StartPeriod}ns`)}`);
  }
  return lines;
};
