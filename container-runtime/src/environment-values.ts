import { EnvironmentValueResolutionError, PlanReplanRequiredError } from "@lando/sdk/errors";
import type { AppPlan, EnvironmentValue, ServicePlan } from "@lando/sdk/schema";

/** Observation is intentionally broader than permission to create containers. */
export const requireCurrentCreationPlan = (plan: AppPlan): void => {
  if (plan.valueModel !== 1) {
    throw new PlanReplanRequiredError({
      providerId: plan.provider,
      operation: "bringUp.create",
      app: plan.id,
      message: "Container creation requires a freshly planned value model.",
      remediation: "Replan the app with `lando start` before creating or replacing containers.",
    });
  }
};

/** No callback means literals only, never implicit descriptor coercion. */
export const literalServiceEnvironment = (service: ServicePlan): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(service.environment).map(([variable, value]) => {
      if (typeof value !== "string") {
        throw new EnvironmentValueResolutionError({
          variable,
          reason: "unresolved-binding",
          message: `Service ${service.name} environment variable ${variable} requires binding resolution.`,
          remediation: "Provide the service environment resolver before creating this service.",
        });
      }
      return [variable, value];
    }),
  );

/** Preview only: descriptor identity is visible without looking up secret bytes. */
export const previewEnvironmentValue = (value: EnvironmentValue): string =>
  typeof value === "string" ? value : JSON.stringify(value);
