import type { ServicePlan } from "@lando/sdk/schema";
import { Equal } from "effect";
import type { DataVersionProcess } from "./draft.ts";

export const finalizeDataVersion = (
  service: ServicePlan,
  process: DataVersionProcess | undefined,
): ServicePlan => {
  if (service.dataVersion?.series === undefined) return service;
  if (
    process?.artifactRef !== undefined &&
    service.artifact?.kind === "ref" &&
    service.artifact.ref === process.artifactRef &&
    Equal.equals(service.command, process.command) &&
    Equal.equals(service.entrypoint, process.entrypoint) &&
    Equal.equals(service.environment.PGDATA, process.pgdata)
  )
    return service;
  const { series: _series, ...dataVersion } = service.dataVersion;
  return { ...service, dataVersion };
};
