import { serviceProbeInputIssue, serviceProbeListener } from "@lando/container-runtime/service-probe";
import { LandofileValidationError } from "@lando/sdk/errors";
import { type AppPlan, probeTargetError, serviceListenerTarget } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { bunShellDialectIssues, describeBunShellIssue } from "../services/bun-shell-dialect.ts";

export const validateServiceProbes = Effect.fn("AppPlanner.validateServiceProbes")(function* (plan: AppPlan) {
  for (const service of Object.values(plan.services)) {
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined) continue;
      const invalidTarget = probeTargetError(probe, service.name, role);
      if (invalidTarget !== undefined) return yield* Effect.fail(invalidTarget);
      if (probe.kind === "none") continue;
      const issue = serviceProbeInputIssue(probe);
      if (issue !== undefined)
        return yield* Effect.fail(
          new LandofileValidationError({
            file: plan.metadata.source,
            issues: [
              {
                path: ["services", String(service.name), role, issue.field],
                rule: `landofile.${role}`,
                message: issue.message,
              },
            ],
            message: `Service ${service.name} has an invalid ${role} probe.`,
            remediation: issue.message,
          }),
        );
      if (role === "readiness" && probe.executionTarget === "host" && typeof probe.command === "string") {
        const dialect = bunShellDialectIssues(probe.command);
        const first = dialect[0];
        if (first !== undefined)
          return yield* Effect.fail(
            new LandofileValidationError({
              file: plan.metadata.source,
              issues: dialect.map((issue) => ({
                rule: "landofile.host-shell",
                path: ["services", String(service.name), "readiness", "command"],
                message: describeBunShellIssue(issue),
                suggestion: issue.suggestion,
              })),
              message: `Service ${service.name} host readiness command uses syntax Bun Shell cannot run.`,
              remediation: first.suggestion,
            }),
          );
      }
      const listener = serviceProbeListener(probe);
      if (listener === undefined || probe.kind === "http") continue;
      // Contributed probes name their own service listener; an `endpoints:` override
      // changes exposure, not the port the daemon still listens on.
      const target = serviceListenerTarget(plan, service, listener, { requireDeclared: false });
      if (Result.isFailure(target)) return yield* Effect.fail(target.failure);
    }
  }
});
