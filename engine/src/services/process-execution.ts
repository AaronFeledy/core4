import { ProcessTimeoutError } from "@lando/sdk/errors";
import type {
  ProcessResult,
  ProcessSpawnOptions,
  ProcessStreamChunk,
  ProcessStreamEvent,
} from "@lando/sdk/services";
import { DateTime } from "effect";
import type { CapturedHostExecutionContext } from "./host-execution-context.ts";
import { privateCaptureBudget } from "./private-capture.ts";
import { processCancellation } from "./process-cancellation.ts";
import { pipedOutput, pumpStdin, readProcessText } from "./process-io.ts";
import { buildSpawnOptions, prepareProcessSpawn } from "./process-spawn-context.ts";
import { killProcessTree, registerDetachedProcess } from "./process-tree.ts";

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
    readonly prepared?: { readonly cwd: string; readonly env: Readonly<Record<string, string>> };
  },
): Promise<ProcessResult> => {
  const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const signal =
    input.signal === undefined ? execution.signal : AbortSignal.any([input.signal, execution.signal]);
  await using context =
    execution.prepared === undefined
      ? await prepareProcessSpawn(captured, {
          signal,
          bunCommandEnv: execution.bunCommandEnv,
        })
      : { ...execution.prepared, [Symbol.asyncDispose]: async () => {} };
  if (signal.aborted) throw processCancellation;
  // Captured runs are private helpers (git transports, probes) and may be killed as a group. Streaming runs keep
  // the terminal session so tools like ssh and sudo can still prompt on /dev/tty.
  const detached = input.capture === true && input.inheritStdin !== true && input.inheritOutput !== true;
  const proc = Bun.spawn([input.cmd, ...input.args], {
    ...buildSpawnOptions({ ...input, cwd: context.cwd, env: context.env }, captured.platform),
    detached,
  });
  if (detached) registerDetachedProcess(proc);
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    // An open pipe does not prove a numeric PID or PGID still identifies our child.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    if (detached) killProcessTree(proc.pid, signal);
    else proc.kill(signal);
  };
  const stopReading = new AbortController();
  const stopStdin = new AbortController();
  let abortedBeforeExit = false;
  const abort = () => {
    abortedBeforeExit = proc.exitCode === null;
    if (abortedBeforeExit) stopStdin.abort(processCancellation);
    stopReading.abort(processCancellation);
    kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutGate =
    input.timeoutMs === undefined
      ? new Promise<never>(() => {})
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            kill("SIGTERM");
            reject(timeoutError(input, DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAt));
          }, input.timeoutMs);
        });
  const budget = input.capture === true ? privateCaptureBudget(input) : undefined;
  const stdoutPromise = readProcessText(
    proc.stdout,
    stopReading.signal,
    budget === undefined ? undefined : (chunk) => budget({ kind: "stdout", chunk }),
  );
  const stderrPromise = readProcessText(
    proc.stderr,
    stopReading.signal,
    budget === undefined ? undefined : (chunk) => budget({ kind: "stderr", chunk }),
  );
  const stdinPump = pumpStdin(proc, { ...input, signal: stopStdin.signal });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([stdoutPromise, stderrPromise, proc.exited, stdinPump]),
      timeoutGate,
    ]);
    if (abortedBeforeExit) throw processCancellation;
    return { exitCode, stdout, stderr };
  } catch (cause) {
    if (!stopReading.signal.aborted) {
      stopStdin.abort(processCancellation);
      stopReading.abort(processCancellation);
      kill("SIGKILL");
    }
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await proc.exited;
    await Promise.allSettled([stdinPump, stdoutPromise, stderrPromise]);
  }
};

export function openProcessStream(
  input: ProcessSpawnOptions,
  platform: CapturedHostExecutionContext["platform"],
  includeExitCode: boolean,
) {
  if (input.signal?.aborted) throw processCancellation;
  const proc = Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input, platform));
  const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const childRunning = () => proc.exitCode === null && proc.signalCode === null;
  const stopStdin = new AbortController();
  const stdinPump = pumpStdin(proc, { ...input, signal: stopStdin.signal });
  void stdinPump.catch(() => {
    if (!stopStdin.signal.aborted && childRunning()) proc.kill();
  });
  const queue: ProcessStreamChunk[] = [];
  const queueLimit = 16;
  const budget = privateCaptureBudget(input);
  const stdoutStream = pipedOutput(proc.stdout);
  const stderrStream = pipedOutput(proc.stderr);
  let failure: { readonly cause: unknown } | undefined;
  let cancelled = false;
  let aborted = false;
  let abandonedOutput = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = Promise.withResolvers<void>();
  const readersWaiting: Array<() => void> = [];
  const consumerWaiting: Array<() => void> = [];
  const wakeConsumer = () => {
    for (const wake of consumerWaiting.splice(0)) wake();
  };
  const wakeReaders = () => {
    for (const wake of readersWaiting.splice(0)) wake();
  };
  const abort = () => {
    if (killTimer === undefined && childRunning()) {
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (childRunning()) proc.kill("SIGKILL");
      }, 500);
    }
    stopStdin.abort();
    stopped.resolve();
    wakeReaders();
    wakeConsumer();
  };
  if (input.timeoutMs !== undefined)
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, input.timeoutMs);
  const enqueue = async (value: ProcessStreamChunk): Promise<void> => {
    while (queue.length >= queueLimit && !cancelled && failure === undefined && !aborted && !abandonedOutput)
      await new Promise<void>((resolve) => readersWaiting.push(resolve));
    if (cancelled || failure !== undefined || aborted || abandonedOutput) return;
    queue.push(value);
    wakeConsumer();
  };
  const readers = new Set<ReturnType<ReadableStream<Uint8Array>["getReader"]>>();
  const waitingReaders = new Set<ReturnType<ReadableStream<Uint8Array>["getReader"]>>();
  const drain = async (stream: ReadableStream<Uint8Array>, kind: ProcessStreamChunk["kind"]) => {
    const reader = stream.getReader();
    readers.add(reader);
    try {
      while (!cancelled && !aborted && !abandonedOutput) {
        waitingReaders.add(reader);
        const next = await reader.read();
        waitingReaders.delete(reader);
        if (next.done || abandonedOutput) break;
        const chunk = next.value;
        if (input.capture === true) budget({ kind, chunk });
        await enqueue({ kind, chunk });
      }
    } catch (cause) {
      if (!cancelled) {
        failure ??= { cause };
        if (childRunning()) proc.kill(input.capture === true ? "SIGKILL" : "SIGTERM");
        wakeReaders();
      }
    } finally {
      readers.delete(reader);
      waitingReaders.delete(reader);
      reader.releaseLock();
      wakeConsumer();
    }
  };
  const stdoutReader = stdoutStream && drain(stdoutStream, "stdout");
  const stderrReader = stderrStream && drain(stderrStream, "stderr");
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const closeReaders = () => {
    for (const reader of readers) void reader.cancel().catch(() => undefined);
  };
  const abortRequest = () => {
    // Bun's exited promise can resolve to a number on signal death; only exitCode proves normal exit.
    if (proc.exitCode === null) {
      aborted = true;
      abort();
    } else if (readers.size > 0) {
      // Stop ingesting inherited output without signalling unrelated background processes.
      // Already-queued chunks can still be delivered, but abandoned output is not clean EOF.
      abandonedOutput = true;
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      closeReaders();
      wakeReaders();
      wakeConsumer();
    }
  };
  input.signal?.addEventListener("abort", abortRequest, { once: true });
  if (input.signal?.aborted) abortRequest();
  const closeIdleReaders = () => {
    if (queue.length === 0) for (const reader of waitingReaders) void reader.cancel().catch(() => undefined);
    if (readers.size > 0) drainTimer = setTimeout(closeIdleReaders, 1000);
  };
  void proc.exited.then(() => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (!cancelled && !abandonedOutput && readers.size > 0) drainTimer = setTimeout(closeIdleReaders, 1000);
  });
  const iterable: AsyncIterable<ProcessStreamEvent> = {
    async *[Symbol.asyncIterator]() {
      const checkStopped = () => {
        if (timedOut) throw timeoutError(input, DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAt);
        if (aborted) throw processCancellation;
      };
      while (!cancelled) {
        if (aborted && failure !== undefined) throw failure.cause;
        checkStopped();
        const value = queue.shift();
        if (value !== undefined) {
          wakeReaders();
          yield value;
          continue;
        }
        if (failure !== undefined) throw failure.cause;
        if (abandonedOutput) throw processCancellation;
        if (readers.size === 0) break;
        await new Promise<void>((resolve) => consumerWaiting.push(resolve));
      }
      if (cancelled) return;
      const exitCode = await Promise.race([stdinPump.then(() => proc.exited), stopped.promise]);
      if (cancelled) return;
      checkStopped();
      if (includeExitCode && exitCode !== undefined) yield { exitCode };
    },
  };
  const close = async () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    input.signal?.removeEventListener("abort", abortRequest);
    abort();
    // Descendants may still hold the pipes. Reap the direct child without waiting for pipe EOF.
    closeReaders();
    await Promise.all([stdoutReader, stderrReader]).finally(() => proc.exited);
  };
  return { iterable, close };
}
