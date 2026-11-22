import {
  type AppPlan,
  ComposeDurationSecondsField,
  ServiceName,
  type ServicePlan,
  probeTargetError,
} from "@lando/sdk/schema";
import { Predicate, Result, Schema } from "effect";
import { compileServiceProbe } from "./service-probe.ts";

export const normalizeCommand = (
  command: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (command === undefined) return undefined;
  if (typeof command === "string") return ["sh", "-c", command];
  return [...command];
};

export const normalizeEntrypoint = (
  entrypoint: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (entrypoint === undefined) return undefined;
  if (typeof entrypoint === "string") return [entrypoint];
  return [...entrypoint];
};

/** Native StartInterval nanoseconds from the healthcheck compose extension only. */
export const nativeStartIntervalNs = (service?: Pick<ServicePlan, "extensions">): number | undefined => {
  const compose = service?.extensions.compose;
  if (!Predicate.isObject(compose)) return undefined;
  const healthcheck = compose.healthcheck;
  if (!Predicate.isObject(healthcheck) || typeof healthcheck.start_interval !== "string") return undefined;
  const decoded = Schema.decodeUnknownResult(ComposeDurationSecondsField)(healthcheck.start_interval);
  if (Result.isFailure(decoded)) return undefined;
  return decoded.success * 1_000_000_000;
};

export const containerHealthcheck = (
  healthcheck: ServicePlan["healthcheck"],
  plan?: Pick<AppPlan, "slug" | "networking">,
  service?: Pick<ServicePlan, "name" | "endpoints" | "extensions">,
) => {
  if (healthcheck === undefined) return undefined;
  const invalid = probeTargetError(healthcheck, service?.name ?? ServiceName.make("unknown"), "healthcheck");
  if (invalid !== undefined) throw invalid;
  const startInterval = nativeStartIntervalNs(service);
  switch (healthcheck.kind) {
    case "none":
      return { Test: ["NONE"] };
    case "command":
    case "http":
    case "tcp": {
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
        ...(startInterval === undefined ? {} : { StartInterval: startInterval }),
      };
    }
  }
};
