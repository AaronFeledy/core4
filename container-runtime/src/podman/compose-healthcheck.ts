import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { Predicate } from "effect";
import { containerHealthcheck } from "../create-values.ts";

const extensionStartInterval = (service: ServicePlan): string | undefined => {
  const compose = service.extensions.compose;
  if (!Predicate.isObject(compose)) return undefined;
  const healthcheck = compose.healthcheck;
  if (!Predicate.isObject(healthcheck) || typeof healthcheck.start_interval !== "string") return undefined;
  return healthcheck.start_interval;
};

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
    const startInterval = extensionStartInterval(service);
    if (startInterval !== undefined) lines.push(`      start_interval: ${quoteYamlScalar(startInterval)}`);
    else if (check.StartInterval !== undefined)
      lines.push(`      start_interval: ${quoteYamlScalar(`${check.StartInterval}ns`)}`);
  }
  return lines;
};
