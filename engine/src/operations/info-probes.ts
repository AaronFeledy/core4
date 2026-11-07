import {
  type HealthcheckPlan,
  type ServiceInfo,
  type ServicePlan,
  effectiveReadiness,
} from "@lando/sdk/schema";
import type { ObservedService } from "./connection-collector.ts";
import { serviceStateOf } from "./connection-state.ts";

type ProbeInfo = NonNullable<NonNullable<ServiceInfo["health"]>["check"]>;

const probeIdentity = (probe: HealthcheckPlan, service: ServicePlan) => {
  const target = probe.executionTarget ?? "service";
  switch (target) {
    case "host":
      return { userSource: "cli" as const };
    case "service": {
      if (probe.user !== undefined) return { userSource: "probe" as const, user: probe.user };
      if (service.user !== undefined) return { userSource: "service" as const, user: service.user };
      return { userSource: "image" as const };
    }
    default:
      return target satisfies never;
  }
};

const describeProbe = (
  probe: HealthcheckPlan,
  service: ServicePlan,
  field: "readiness" | "healthcheck",
): ProbeInfo => ({
  kind: probe.kind,
  intervalSeconds: probe.intervalSeconds,
  timeoutSeconds: probe.timeoutSeconds,
  retries: probe.retries,
  ...(probe.startPeriodSeconds === undefined ? {} : { startPeriodSeconds: probe.startPeriodSeconds }),
  target: probe.executionTarget ?? "service",
  ...probeIdentity(probe, service),
  ...(probe.target === undefined ? {} : { listener: probe.target }),
  commandConfigured: probe.kind !== "none" && probe.command !== undefined,
  configPath: ["services", String(service.name), field],
});

export const projectServiceObservation = (
  service: ServicePlan,
  observed: ObservedService,
): Pick<ServiceInfo, "status" | "health" | "readiness"> => {
  const { runtime } = observed;
  const readiness = effectiveReadiness(service);
  return {
    status: serviceStateOf(runtime, observed.state === "completed"),
    health: {
      state: service.healthcheck?.kind === "none" ? "not-monitored" : (runtime.health ?? "unknown"),
      ...(service.healthcheck === undefined
        ? {}
        : { check: describeProbe(service.healthcheck, service, "healthcheck") }),
    },
    readiness: {
      state:
        readiness === undefined ? "not-configured" : readiness.kind === "none" ? "disabled" : "not-observed",
      source:
        service.readiness === undefined
          ? readiness === undefined
            ? "none"
            : "healthcheck"
          : (service.readinessSource ?? "unknown"),
      ...(readiness === undefined
        ? {}
        : {
            check: describeProbe(
              readiness,
              service,
              service.readiness === undefined ? "healthcheck" : "readiness",
            ),
          }),
    },
  };
};
