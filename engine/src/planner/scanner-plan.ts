import type { AppPlan, ScanPlan, ScannerConfig } from "@lando/sdk/schema";

import type { ResolvedService } from "./service-types.ts";

const defaults: ScanPlan = {
  enabled: true,
  path: "/",
  okCodes: [],
  retries: 2,
  timeoutMs: 20000,
};

const overlay = (prior: ScanPlan, layer: ScannerConfig | undefined): ScanPlan => {
  if (layer === undefined) return prior;
  if (layer === false) return { ...prior, enabled: false };
  return {
    enabled: true,
    path: layer.path ?? prior.path,
    okCodes: layer.okCodes ?? prior.okCodes,
    retries: layer.retries ?? prior.retries,
    timeoutMs: layer.timeout ?? prior.timeoutMs,
  };
};

export const resolveScanPlan = (
  global: ScannerConfig | undefined,
  service: ScannerConfig | undefined,
): ScanPlan => overlay(overlay(defaults, global), service);

export const attachScanPlans = (
  plan: AppPlan,
  global: ScannerConfig | undefined,
  resolvedServices: ReadonlyArray<ResolvedService>,
): AppPlan => {
  const configs = new Map(
    resolvedServices.map(({ name, resolution }) => [name, resolution.normalizedConfig.scanner]),
  );
  return {
    ...plan,
    services: Object.fromEntries(
      Object.entries(plan.services).map(([name, service]) => [
        name,
        { ...service, scanner: resolveScanPlan(global, configs.get(name)) },
      ]),
    ),
  };
};
