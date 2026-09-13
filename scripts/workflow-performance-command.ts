import { boundedPerformanceEvidence } from "./workflow-performance-report.ts";

export type WorkflowPerformanceCommand = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type WorkflowPerformanceCommandResult = {
  readonly id: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const workflowPerformanceDeadlineRunner = (input: {
  readonly runCommand: (command: WorkflowPerformanceCommand) => Promise<WorkflowPerformanceCommandResult>;
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
  readonly sampleTimeoutMs?: number;
}) => {
  const deadline = performance.now() + (input.sampleTimeoutMs ?? 600_000);
  return async (command: WorkflowPerformanceCommand): Promise<WorkflowPerformanceCommandResult> => {
    const started = performance.now();
    if (started >= deadline)
      return {
        id: command.id,
        durationMs: 0,
        exitCode: 124,
        stdout: "",
        stderr: "sample deadline exhausted before command",
      };
    try {
      return await input.runCommand({
        ...command,
        timeoutMs: Math.max(1, Math.min(input.commandTimeoutMs ?? 120_000, deadline - performance.now())),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      return {
        id: command.id,
        durationMs: performance.now() - started,
        exitCode: 1,
        stdout: "",
        stderr: boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause)),
      };
    }
  };
};

export const runWorkflowPerformanceCommand = async (
  command: WorkflowPerformanceCommand,
): Promise<WorkflowPerformanceCommandResult> => {
  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  let timedOut = false;
  try {
    if (command.signal?.aborted)
      return { id: command.id, durationMs: 0, exitCode: 130, stdout, stderr: "interrupted before spawn" };
    const proc = Bun.spawn({
      cmd: [...command.argv],
      cwd: command.cwd,
      env: { ...command.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
    const stop = () => {
      proc.kill("SIGKILL");
      for (const reader of readers) void reader.cancel();
    };
    const abort = () => {
      interrupted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs ?? 120_000);
    command.signal?.addEventListener("abort", abort, { once: true });
    const collect = async (reader: (typeof readers)[number], append: (chunk: string) => void) => {
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(decoder.decode(chunk.value, { stream: true }));
      }
      append(decoder.decode());
    };
    let exitCode: number;
    try {
      const streams = readers.map((reader, index) =>
        collect(reader, (chunk) => {
          if (index === 0) stdout = boundedPerformanceEvidence(stdout + chunk);
          else stderr = boundedPerformanceEvidence(stderr + chunk);
        }),
      );
      [exitCode] = await Promise.all([proc.exited, ...streams]);
    } finally {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", abort);
      if (proc.exitCode === null && proc.signalCode === null) stop();
      await proc.exited;
      for (const reader of readers) reader.releaseLock();
    }
    return {
      id: command.id,
      durationMs: performance.now() - startedAt,
      exitCode: timedOut ? 124 : interrupted ? 130 : exitCode,
      stdout: boundedPerformanceEvidence(stdout),
      stderr: boundedPerformanceEvidence(
        stderr + (timedOut ? "\n[command timeout]" : interrupted ? "\n[interrupted]" : ""),
      ),
    };
  } catch (cause) {
    return {
      id: command.id,
      durationMs: performance.now() - startedAt,
      exitCode: 1,
      stdout,
      stderr: boundedPerformanceEvidence(
        `${stderr}\n[spawn or stream failure] ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    };
  }
};
