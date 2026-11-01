import { HealthcheckTargetUnsupportedError, ProviderConfigError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type HealthcheckPlan,
  type ServiceName,
  effectiveReadiness,
  probeTargetError,
} from "@lando/sdk/schema";
import type { ApplyOptions } from "@lando/sdk/services";
import { Effect } from "effect";

export const unsupportedHealthcheckTarget = (
  service: ServiceName,
  probe: Pick<HealthcheckPlan, "executionTarget">,
) =>
  new HealthcheckTargetUnsupportedError({
    service: String(service),
    target: probe.executionTarget ?? "service",
    message: "Host readiness requires an engine-owned attempt delegate.",
    remediation:
      "Apply this plan through the engine with host readiness runners, or use a service readiness probe.",
  });

export const validateProbeTarget = (probe: HealthcheckPlan, service: ServiceName) => {
  const invalid = probeTargetError(probe, service, "readiness");
  return invalid === undefined ? Effect.void : Effect.fail(invalid);
};

export const validateHealthcheckExecution = Effect.fnUntraced(function* (
  plan: AppPlan,
  executeReadinessAttempt?: ApplyOptions["executeReadinessAttempt"],
) {
  for (const service of Object.values(plan.services)) {
    for (const dependency of service.dependsOn) {
      if (dependency.condition !== "service_healthy") continue;
      const target = plan.services[dependency.service];
      if (target === undefined) continue;
      const probe = effectiveReadiness(target);
      if (probe?.kind !== "command" || probe.command === undefined)
        return yield* Effect.fail(
          new ProviderConfigError({
            providerId: String(plan.provider),
            operation: "readiness.preflight",
            message: `Service ${service.name} requires command readiness from ${target.name}, but that policy is disabled or unavailable.`,
            remediation:
              "Configure an enabled readiness command or change the dependency to service_started. Optional dependencies still require a satisfiable healthy gate.",
          }),
        );
    }
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined) continue;
      const invalid = probeTargetError(probe, service.name, role);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
      if (probe.kind !== "none" && probe.executionTarget === "host" && executeReadinessAttempt === undefined)
        return yield* Effect.fail(unsupportedHealthcheckTarget(service.name, probe));
    }
  }
});

export const interruptOnAbort = <A, E, R>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) => {
  if (signal === undefined) return effect;
  if (signal.aborted) return Effect.interrupt;
  return Effect.raceFirst(
    effect,
    Effect.callback<never>((resume) => {
      const abort = () => resume(Effect.interrupt);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    }),
  );
};
