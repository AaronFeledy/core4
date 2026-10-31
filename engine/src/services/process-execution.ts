import { ProcessTimeoutError } from "@lando/sdk/errors";
import type {
  ProcessResult,
  ProcessSpawnOptions,
  ProcessStreamChunk,
  ProcessStreamEvent,
} from "@lando/sdk/services";
import { DateTime } from "effect";
import type { CapturedHostExecutionContext } from "./host-execution-context.ts";
import { collectPrivateText, privateCaptureBudget } from "./private-capture.ts";
import { pipedOutput, pumpStdin, readText } from "./process-io.ts";
import { buildSpawnOptions, prepareProcessSpawn } from "./process-spawn-context.ts";

const timeoutError = (input: ProcessSpawnOptions, elapsedMs: number) =>
  new ProcessTimeoutError({
    message: `Process timed out after ${elapsedMs}ms: ${input.cmd}`,
    cmd: input.cmd,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    elapsedMs,
    remediation:
      input.timeoutMs === undefined
        ? `Investigate why \`${input.cmd}\` did not finish within ${elapsedMs}ms, or pass a higher timeoutMs.`
        : `Increase timeoutMs for \`${input.cmd}\` above ${input.timeoutMs}ms (timed out after ${elapsedMs}ms), or investigate why it did not finish.`,
  });

export const runProcess = async (
  input: ProcessSpawnOptions,
  captured: CapturedHostExecutionContext,
  execution: {
    readonly signal: AbortSignal;
    readonly bunCommandEnv: boolean;
  },
): Promise<ProcessResult> => {
  const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const signal =
    input.signal === undefined ? execution.signal : AbortSignal.any([input.signal, execution.signal]);
  await using context = await prepareProcessSpawn(captured, {
    signal,
    bunCommandEnv: execution.bunCommandEnv,
  });
  signal.throwIfAborted();
  const proc = Bun.spawn(
    [input.cmd, ...input.args],
    buildSpawnOptions({ ...input, cwd: context.cwd, env: context.env }),
  );
  const abort = () => proc.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutGate =
    input.timeoutMs === undefined
      ? new Promise<void>(() => {})
      : new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolve();
          }, input.timeoutMs);
        });
  const budget = privateCaptureBudget(input);
  const stdoutPromise =
    input.capture === true
      ? collectPrivateText(pipedOutput(proc.stdout), (chunk) => budget({ kind: "stdout", chunk }))
      : readText(proc.stdout);
  const stderrPromise =
    input.capture === true
      ? collectPrivateText(pipedOutput(proc.stderr), (chunk) => budget({ kind: "stderr", chunk }))
      : readText(proc.stderr);
  const stdinPump = pumpStdin(proc, { ...input, signal });
  const output =
    input.capture === true ? Promise.all([stdoutPromise, stderrPromise, proc.exited, stdinPump]) : undefined;
  try {
    await Promise.race(
      output === undefined
        ? [proc.exited, timeoutGate, stdinPump.then(() => proc.exited)]
        : [output, timeoutGate],
    );
    if (timedOut) throw timeoutError(input, DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAt);
    signal.throwIfAborted();
    await stdinPump;
    const [stdout, stderr, exitCode] = await (output ??
      Promise.all([stdoutPromise, stderrPromise, proc.exited]));
    return { exitCode, stdout, stderr };
  } catch (cause) {
    proc.kill("SIGKILL");
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    const settled = Promise.allSettled([stdinPump, stdoutPromise, stderrPromise]);
    if (input.capture === true) await settled;
  }
};

export async function* streamProcess(
  input: ProcessSpawnOptions,
  captured: CapturedHostExecutionContext,
  execution: { readonly includeExitCode: boolean; readonly bunCommandEnv: boolean },
): AsyncGenerator<ProcessStreamEvent> {
  await using context = await prepareProcessSpawn(captured, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    bunCommandEnv: execution.bunCommandEnv,
  });
  input.signal?.throwIfAborted();
  const proc = Bun.spawn(
    [input.cmd, ...input.args],
    buildSpawnOptions({ ...input, cwd: context.cwd, env: context.env }),
  );
  const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdinPump = pumpStdin(proc, input);
  void stdinPump.catch(() => proc.kill());
  const queue: ProcessStreamChunk[] = [];
  const queueLimit = 16;
  const budget = privateCaptureBudget(input);
  const stdoutStream = pipedOutput(proc.stdout);
  const stderrStream = pipedOutput(proc.stderr);
  let openReaders = (stdoutStream === undefined ? 0 : 1) + (stderrStream === undefined ? 0 : 1);
  let failure: unknown;
  let failed = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const readersWaiting: Array<() => void> = [];
  const consumerWaiting: Array<() => void> = [];
  const wakeConsumer = () => {
    for (const wake of consumerWaiting.splice(0)) wake();
  };
  const wakeReaders = () => {
    for (const wake of readersWaiting.splice(0)) wake();
  };
  const abort = () => {
    proc.kill("SIGTERM");
    killTimer ??= setTimeout(() => proc.kill("SIGKILL"), 500);
    wakeReaders();
    wakeConsumer();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.timeoutMs !== undefined)
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, input.timeoutMs);
  const enqueue = async (value: ProcessStreamChunk): Promise<void> => {
    while (queue.length >= queueLimit && !cancelled && !failed && !input.signal?.aborted)
      await new Promise<void>((resolve) => readersWaiting.push(resolve));
    if (cancelled || failed || input.signal?.aborted) return;
    queue.push(value);
    wakeConsumer();
  };
  const readers = new Set<ReturnType<ReadableStream<Uint8Array>["getReader"]>>();
  const waitingReaders = new Set<ReturnType<ReadableStream<Uint8Array>["getReader"]>>();
  const drain = async (stream: ReadableStream<Uint8Array>, kind: ProcessStreamChunk["kind"]) => {
    const reader = stream.getReader();
    readers.add(reader);
    try {
      for (;;) {
        waitingReaders.add(reader);
        const next = await reader.read();
        waitingReaders.delete(reader);
        if (next.done) break;
        const chunk = next.value;
        if (input.capture === true) budget({ kind, chunk });
        await enqueue({ kind, chunk });
      }
    } catch (cause) {
      if (!failed) {
        failed = true;
        failure = cause;
      }
      proc.kill(input.capture === true ? "SIGKILL" : "SIGTERM");
      wakeReaders();
    } finally {
      readers.delete(reader);
      waitingReaders.delete(reader);
      reader.releaseLock();
      openReaders--;
      wakeConsumer();
    }
  };
  const stdoutReader = stdoutStream === undefined ? Promise.resolve() : drain(stdoutStream, "stdout");
  const stderrReader = stderrStream === undefined ? Promise.resolve() : drain(stderrStream, "stderr");
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const closeIdleReaders = () => {
    if (queue.length === 0) for (const reader of waitingReaders) void reader.cancel().catch(() => undefined);
    if (readers.size > 0) drainTimer = setTimeout(closeIdleReaders, 1000);
  };
  void proc.exited.then(() => {
    if (openReaders > 0) drainTimer = setTimeout(closeIdleReaders, 1000);
  });
  try {
    for (;;) {
      if (timedOut) throw timeoutError(input, DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAt);
      input.signal?.throwIfAborted();
      const value = queue.shift();
      if (value !== undefined) {
        wakeReaders();
        yield value;
        continue;
      }
      if (failed) throw failure;
      if (openReaders === 0) break;
      await new Promise<void>((resolve) => consumerWaiting.push(resolve));
    }
    await Promise.all([stdoutReader, stderrReader]);
    await stdinPump;
    const exitCode = await proc.exited;
    input.signal?.throwIfAborted();
    if (execution.includeExitCode) yield { exitCode };
  } finally {
    cancelled = true;
    wakeReaders();
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (proc.exitCode === null) abort();
    await proc.exited;
    if (killTimer !== undefined) clearTimeout(killTimer);
    for (const reader of readers) await reader.cancel();
    await Promise.all([stdoutReader, stderrReader]);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
  }
}
