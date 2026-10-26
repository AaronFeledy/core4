import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { compileServiceProbe } from "./service-probe.ts";

export const normalizeCommand = (
  command: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (command === undefined) return undefined;
  if (typeof command === "string") return ["sh", "-lc", command];
  return [...command];
};

export const normalizeEntrypoint = (
  entrypoint: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (entrypoint === undefined) return undefined;
  if (typeof entrypoint === "string") return [entrypoint];
  return [...entrypoint];
};

export const containerHealthcheck = (
  healthcheck: ServicePlan["healthcheck"],
  plan?: Pick<AppPlan, "slug" | "networking">,
  service?: Pick<ServicePlan, "name" | "endpoints">,
) => {
  if (healthcheck === undefined) return undefined;
  switch (healthcheck.kind) {
    case "none":
      return { Test: ["NONE"] };
    case "command": {
      const command = compileServiceProbe(healthcheck, plan, service);
      if (command === undefined) return undefined;
      return {
        Test: ["CMD", ...command],
        Interval: healthcheck.intervalSeconds * 1_000_000_000,
        Timeout: healthcheck.timeoutSeconds * 1_000_000_000,
        Retries: healthcheck.retries,
        ...(healthcheck.startPeriodSeconds === undefined
          ? {}
          : { StartPeriod: healthcheck.startPeriodSeconds * 1_000_000_000 }),
      };
    }
    case "http":
    case "tcp":
      return undefined;
  }
};
