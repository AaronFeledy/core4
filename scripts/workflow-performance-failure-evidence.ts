import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Exit } from "effect";

import { makeEnvSecretStoreLive } from "@lando/engine/services/secret-store";
import { RedactionService, RedactionServiceLive } from "@lando/redaction/service";
import type { WorkflowPerformanceCommandResult } from "./workflow-performance-command.ts";
import { boundedPerformanceEvidence } from "./workflow-performance-report.ts";

const SERVICE_LOG_TAIL_BYTES = 4096;
const OMITTED_DIAGNOSTIC = "[diagnostic evidence omitted]";

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
  sourceEnv: Record<string, string | undefined>,
): Promise<WorkflowPerformanceCommandResult> => {
  const serviceLogTail = await readServiceLogTail(dataRoot);
  const redactorExit = await Effect.runPromiseExit(
    Effect.flatMap(RedactionService, (service) => service.forProfile("telemetry", { sourceEnv })).pipe(
      Effect.provide(RedactionServiceLive),
      Effect.provide(makeEnvSecretStoreLive({ env: sourceEnv })),
    ),
  );
  if (Exit.isFailure(redactorExit)) {
    return { ...result, stdout: "", stderr: OMITTED_DIAGNOSTIC };
  }
  const redactor = redactorExit.value;
  const stderr =
    serviceLogTail === undefined
      ? redactor.redactString(result.stderr)
      : `${redactor.redactString(result.stderr)}\n[podman service log tail]\n${redactor.redactString(serviceLogTail)}`;
  return {
    ...result,
    stdout: boundedPerformanceEvidence(redactor.redactString(result.stdout)),
    stderr: boundedPerformanceEvidence(stderr),
  };
};
