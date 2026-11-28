import type { ServicePlan } from "@lando/sdk/schema";
import { Equal } from "effect";
import type { DataVersionProcess } from "./draft.ts";

type ProcessInvocation = {
  readonly command?: ServicePlan["command"];
  readonly entrypoint?: ServicePlan["entrypoint"];
};

const sameInvocation = (left: ProcessInvocation, right: ProcessInvocation) =>
  Equal.equals(left.command, right.command) && Equal.equals(left.entrypoint, right.entrypoint);

export const dataVersionProcessWithExtraArgs = (
  captured: DataVersionProcess | undefined,
  original: ProcessInvocation,
  appended: ProcessInvocation | undefined,
): DataVersionProcess | undefined =>
  captured !== undefined && appended !== undefined && sameInvocation(captured, original)
    ? { ...captured, command: appended.command }
    : captured;

export const finalizeDataVersion = (
  service: ServicePlan,
  process: DataVersionProcess | undefined,
): ServicePlan => {
  if (service.dataVersion?.series === undefined) return service;
  if (
    process?.artifactRef !== undefined &&
    service.artifact?.kind === "ref" &&
    service.artifact.ref === process.artifactRef &&
    sameInvocation(service, process) &&
    Equal.equals(service.environment.PGDATA, process.pgdata)
  )
    return service;
  const { series: _series, ...dataVersion } = service.dataVersion;
  return { ...service, dataVersion };
};
