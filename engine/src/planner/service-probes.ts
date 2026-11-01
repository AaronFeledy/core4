import { LandofileValidationError } from "@lando/sdk/errors";
import { type AppPlan, probeTargetError, serviceListenerTarget, validationIssue } from "@lando/sdk/schema";
import { Effect, Result } from "effect";

export const validateServiceProbes = Effect.fn("AppPlanner.validateServiceProbes")(function* (plan: AppPlan) {
  for (const service of Object.values(plan.services)) {
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined) continue;
      const invalidTarget = probeTargetError(probe, service.name, role);
      if (invalidTarget !== undefined) return yield* Effect.fail(invalidTarget);
      if (probe.kind === "none") continue;
      if (probe.kind !== "command" || probe.command === undefined)
        return yield* Effect.fail(
          new LandofileValidationError({
            file: ".lando.yml",
            issues: [
              validationIssue(
                ["services", String(service.name), role, probe.kind === "command" ? "command" : "kind"],
                "Configure an enabled command probe.",
              ),
            ],
            message: `Service ${service.name} requires a command probe.`,
            remediation: `Supply a command for ${role}, or explicitly disable it with false.`,
          }),
        );
      if (probe.target === undefined) continue;
      // Contributed probes name their own service listener; an `endpoints:` override
      // changes exposure, not the port the daemon still listens on.
      const target = serviceListenerTarget(plan, service, probe.target, { requireDeclared: false });
      if (Result.isFailure(target)) return yield* Effect.fail(target.failure);
    }
  }
});
