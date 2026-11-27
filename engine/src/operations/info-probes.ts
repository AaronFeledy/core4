import {
  type HealthcheckPlan,
  type ProviderCapabilities,
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

type HealthState = NonNullable<ServiceInfo["health"]>["state"];

/**
 * Native health as evidence: an explicit `none` check is not monitored, and a check nothing
 * schedules (`serviceHealth: "none"`) stays at whatever the engine last recorded, so it is unknown.
 */
const nativeHealthState = (
  service: ServicePlan,
  runtimeHealth: HealthState | undefined,
  serviceHealth: ProviderCapabilities["serviceHealth"],
): HealthState => {
  if (service.healthcheck?.kind === "none") return "not-monitored";
  switch (serviceHealth) {
    case "none":
      return "unknown";
    case "native":
    case "lando":
      return runtimeHealth ?? "unknown";
    default:
      return serviceHealth satisfies never;
  }
};

export const projectServiceObservation = (
  service: ServicePlan,
  observed: ObservedService,
  serviceHealth: ProviderCapabilities["serviceHealth"],
): Pick<ServiceInfo, "status" | "health" | "readiness"> => {
  const { runtime } = observed;
  const readiness = effectiveReadiness(service);
  const healthState = nativeHealthState(service, runtime.health, serviceHealth);
  const observedVerdict = healthState !== "unknown" && healthState !== "not-monitored";
  return {
    status: serviceStateOf(runtime, observed.state === "completed"),
    health: {
      state: healthState,
      ...(observedVerdict && runtime.healthCheckedAt !== undefined
        ? { checkedAt: runtime.healthCheckedAt }
        : {}),
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
