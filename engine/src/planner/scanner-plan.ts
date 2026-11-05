import { type AppPlan, type ScanPlan, type ScannerConfig, logicalEndpointIdentity } from "@lando/sdk/schema";

import { endpointScanPolicies } from "../services/endpoint-scan.ts";
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
    enabled: prior.enabled,
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

export const attachScanPlans = <Plan extends AppPlan>(
  plan: Plan,
  global: ScannerConfig | undefined,
  resolvedServices: ReadonlyArray<Pick<ResolvedService, "name" | "resolution">>,
): Plan => {
  const configs = new Map(
    resolvedServices.map(({ name, resolution }) => [name, resolution.normalizedConfig.scanner]),
  );
  return {
    ...plan,
    services: Object.fromEntries(
      Object.entries(plan.services).map(([name, service]) => {
        const config = configs.get(name);
        const scanner = resolveScanPlan(global, config);
        const globalPolicy = global === false ? undefined : global;
        const servicePolicy = config === false ? undefined : config;
        const policies = endpointScanPolicies(service.endpoints);
        return [
          name,
          {
            ...service,
            scanner,
            endpoints: service.endpoints.map((endpoint) => {
              if (endpoint.protocol !== "http" && endpoint.protocol !== "https") return endpoint;
              const policy = policies.get(logicalEndpointIdentity(endpoint));
              return {
                ...endpoint,
                scan: {
                  path: servicePolicy?.path ?? globalPolicy?.path ?? policy?.path ?? defaults.path,
                  okCodes:
                    servicePolicy?.okCodes ?? globalPolicy?.okCodes ?? policy?.okCodes ?? defaults.okCodes,
                },
              };
            }),
          },
        ];
      }),
    ),
  };
};
