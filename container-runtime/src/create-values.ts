import type { ServicePlan } from "@lando/sdk/schema";

export class ContainerPlanError extends Error {
  readonly _tag = "ContainerPlanError";
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ContainerPlanError";
    if (details !== undefined) this.details = details;
  }
}

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
): Record<string, unknown> | undefined => {
  if (healthcheck === undefined) return undefined;
  switch (healthcheck.kind) {
    case "none":
      return { Test: ["NONE"] };
    case "command": {
      const command = healthcheck.command;
      if (command === undefined) return undefined;
      return {
        Test: typeof command === "string" ? ["CMD-SHELL", command] : ["CMD", ...command],
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
