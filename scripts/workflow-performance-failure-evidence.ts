import type { WorkflowPerformanceCommandResult } from "./workflow-performance-command.ts";
const OMITTED_DIAGNOSTIC = "[diagnostic evidence omitted]";

export const withPodmanServiceEvidence = async (
  result: WorkflowPerformanceCommandResult,
): Promise<WorkflowPerformanceCommandResult> => ({
  ...result,
  stdout: "",
  stderr: OMITTED_DIAGNOSTIC,
});
