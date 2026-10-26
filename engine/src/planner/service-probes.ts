import { LandofileValidationError } from "@lando/sdk/errors";
import { type AppPlan, serviceListenerTarget } from "@lando/sdk/schema";
import { Effect, Result } from "effect";

export const validateServiceProbes = Effect.fn("AppPlanner.validateServiceProbes")(function* (plan: AppPlan) {
  for (const service of Object.values(plan.services)) {
    for (const probe of [service.healthcheck, service.readiness]) {
      if (probe === undefined || probe.kind === "none") continue;
      if (probe.kind !== "command")
        return yield* Effect.fail(
          new LandofileValidationError({
            file: ".lando.yml",
            issues: [],
            message: `Service ${service.name} requires a command probe.`,
            remediation: "Use kind: command or disable the authored healthcheck.",
          }),
        );
      if (probe.target === undefined) continue;
      const target = serviceListenerTarget(plan, service, probe.target);
      if (Result.isFailure(target)) return yield* Effect.fail(target.failure);
    }
  }
});
