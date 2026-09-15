import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkflowPerformanceCommandResult } from "./workflow-performance-command.ts";
import { boundedPerformanceEvidence } from "./workflow-performance-report.ts";

const SERVICE_LOG_TAIL_BYTES = 4096;

const readServiceLogTail = async (dataRoot: string): Promise<string | undefined> => {
  try {
    const log = await readFile(join(dataRoot, "runtime/run/service.log"), "utf8");
    return log.slice(-SERVICE_LOG_TAIL_BYTES);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    return `[service log unavailable] ${cause instanceof Error ? cause.message : String(cause)}`;
  }
};

export const withPodmanServiceEvidence = async (
  result: WorkflowPerformanceCommandResult,
  dataRoot: string,
): Promise<WorkflowPerformanceCommandResult> => {
  const serviceLogTail = await readServiceLogTail(dataRoot);
  if (serviceLogTail === undefined) return result;
  return {
    ...result,
    stderr: boundedPerformanceEvidence(`${result.stderr}\n[podman service log tail]\n${serviceLogTail}`),
  };
};
