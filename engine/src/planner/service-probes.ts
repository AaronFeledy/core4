import { LandofileValidationError } from "@lando/sdk/errors";
import { type AppPlan, probeTargetError, serviceListenerTarget, validationIssue } from "@lando/sdk/schema";
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
      if (probe.target === undefined) continue;
      // Contributed probes name their own service listener; an `endpoints:` override
      // changes exposure, not the port the daemon still listens on.
      const target = serviceListenerTarget(plan, service, probe.target, { requireDeclared: false });
      if (Result.isFailure(target)) return yield* Effect.fail(target.failure);
    }
  }
});
