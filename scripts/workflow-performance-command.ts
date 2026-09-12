import { boundedPerformanceEvidence } from "./workflow-performance-report.ts";

export type WorkflowPerformanceCommand = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

export type WorkflowPerformanceCommandResult = {
  readonly id: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const runWorkflowPerformanceCommand = async (
  command: WorkflowPerformanceCommand,
): Promise<WorkflowPerformanceCommandResult> => {
  const startedAt = performance.now();
  try {
    const proc = Bun.spawn({
      cmd: [...command.argv],
      cwd: command.cwd,
      env: { ...command.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      id: command.id,
      durationMs: performance.now() - startedAt,
      exitCode,
      stdout: boundedPerformanceEvidence(stdout),
      stderr: boundedPerformanceEvidence(stderr),
    };
  } catch (cause) {
    return {
      id: command.id,
      durationMs: performance.now() - startedAt,
      exitCode: 1,
      stdout: "",
      stderr: boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause)),
    };
  }
};
