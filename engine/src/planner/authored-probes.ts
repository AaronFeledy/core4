import type { HealthcheckInput, HealthcheckPlan, ServiceConfig, ServicePlan } from "@lando/sdk/schema";

const mergeProbe = (authored: HealthcheckInput, existing?: HealthcheckPlan): HealthcheckPlan => {
  const base = {
    intervalSeconds: existing?.intervalSeconds ?? 10,
    timeoutSeconds: existing?.timeoutSeconds ?? 5,
    retries: existing?.retries ?? 5,
  };
  if (authored === false) return { ...base, kind: "none" };
  const kind = authored.kind ?? existing?.kind ?? "command";
  const inherited = existing?.kind === kind ? existing : undefined;
  const command = authored.command ?? (authored.target === "host" ? undefined : inherited?.command);
  const url = authored.url ?? inherited?.url;
  const port = authored.port ?? inherited?.port;
  const startPeriodSeconds = authored.startPeriodSeconds ?? existing?.startPeriodSeconds;
  const startIntervalSeconds = authored.startIntervalSeconds ?? existing?.startIntervalSeconds;
  const executionTarget = authored.target ?? existing?.executionTarget;
  const user = authored.user ?? (authored.target === "host" ? undefined : existing?.user);
  return {
    kind,
    intervalSeconds: authored.intervalSeconds ?? base.intervalSeconds,
    timeoutSeconds: authored.timeoutSeconds ?? base.timeoutSeconds,
    retries: authored.retries ?? base.retries,
    ...(executionTarget === undefined ? {} : { executionTarget }),
    ...(user === undefined ? {} : { user }),
    ...(command === undefined ? {} : { command }),
    ...(url === undefined ? {} : { url }),
    ...(port === undefined ? {} : { port }),
    ...(startPeriodSeconds === undefined ? {} : { startPeriodSeconds }),
    ...(startIntervalSeconds === undefined ? {} : { startIntervalSeconds }),
    ...(authored.command === undefined &&
    authored.port === undefined &&
    authored.target !== "host" &&
    inherited?.target !== undefined
      ? { target: inherited.target }
      : {}),
  };
};

export const applyAuthoredHealthcheck = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  if (service.healthcheck === undefined && service.readiness === undefined) return servicePlan;
  const healthcheck =
    service.healthcheck === undefined
      ? servicePlan.healthcheck
      : mergeProbe(service.healthcheck, servicePlan.healthcheck);
  const readinessBase = servicePlan.readiness ?? (healthcheck?.kind === "none" ? undefined : healthcheck);
  return {
    ...servicePlan,
    ...(healthcheck === undefined ? {} : { healthcheck }),
    ...(service.readiness === undefined
      ? {}
      : {
          readiness: mergeProbe(service.readiness, readinessBase),
          readinessSource: "authored" as const,
        }),
  };
};
