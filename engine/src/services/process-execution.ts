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
  signal.throwIfAborted();
  // Captured runs are private helpers (git transports, probes) and may be killed as a group. Streaming runs keep
  // the terminal session so tools like ssh and sudo can still prompt on /dev/tty.
  const detached = input.capture === true && input.inheritStdin !== true && input.inheritOutput !== true;
  const proc = Bun.spawn([input.cmd, ...input.args], {
    ...buildSpawnOptions({ ...input, cwd: context.cwd, env: context.env }, captured.platform),
    detached,
  });
  if (detached) registerDetachedProcess(proc);
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    if (detached) killProcessTree(proc.pid, signal);
    else proc.kill(signal);
  };
  // A killed child's descendants can hold its pipes open; stop reading so abort and timeout settle promptly.
  const stopReading = new AbortController();
  const aborted = Promise.withResolvers<void>();
  const abort = () => {
    kill("SIGKILL");
    stopReading.abort(signal.reason);
    aborted.resolve();
  };
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutGate =
    input.timeoutMs === undefined
      ? new Promise<void>(() => {})
      : new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            kill("SIGTERM");
            stopReading.abort();
            resolve();
          }, input.timeoutMs);
        });
  const budget = privateCaptureBudget(input);
  const stdoutPromise =
    input.capture === true
      ? collectPrivateText(
          pipedOutput(proc.stdout),
          (chunk) => budget({ kind: "stdout", chunk }),
          stopReading.signal,
        )
      : readText(proc.stdout);
  const stderrPromise =
    input.capture === true
      ? collectPrivateText(
          pipedOutput(proc.stderr),
          (chunk) => budget({ kind: "stderr", chunk }),
          stopReading.signal,
        )
      : readText(proc.stderr);
  const stdinPump = pumpStdin(proc, { ...input, signal });
  const output =
    input.capture === true ? Promise.all([stdoutPromise, stderrPromise, proc.exited, stdinPump]) : undefined;
  try {
    await Promise.race(
      output === undefined
        ? [proc.exited, timeoutGate, stdinPump.then(() => proc.exited)]
        : [output, timeoutGate, aborted.promise],
    );
    if (timedOut) throw timeoutError(input, DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAt);
    signal.throwIfAborted();
    await stdinPump;
    const [stdout, stderr, exitCode] = await (output ??
      Promise.all([stdoutPromise, stderrPromise, proc.exited]));
    return { exitCode, stdout, stderr };
  } catch (cause) {
    kill("SIGKILL");
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (proc.exitCode === null) kill("SIGKILL");
    await proc.exited;
    const settled = Promise.allSettled([stdinPump, stdoutPromise, stderrPromise]);
    if (input.capture === true) await settled;
  }
};

export function openProcessStream(
  input: ProcessSpawnOptions,
  platform: CapturedHostExecutionContext["platform"],
  includeExitCode: boolean,
) {
  input.signal?.throwIfAborted();
  const proc = Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input, platform));
  const startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopStdin = new AbortController();
  const stdinPump = pumpStdin(proc, { ...input, signal: stopStdin.signal });
  void stdinPump.catch(() => {
    if (!stopStdin.signal.aborted) proc.kill();
  });
  const queue: ProcessStreamChunk[] = [];
  const queueLimit = 16;
  const budget = privateCaptureBudget(input);
  const stdoutStream = pipedOutput(proc.stdout);
  const stderrStream = pipedOutput(proc.stderr);
  let failure: { readonly cause: unknown } | undefined;
  let cancelled = false;
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
    if (killTimer === undefined && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 500);
    }
    stopStdin.abort();
    stopped.resolve();
    wakeReaders();
    wakeConsumer();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  if (input.timeoutMs !== undefined)
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, input.timeoutMs);
  const enqueue = async (value: ProcessStreamChunk): Promise<void> => {
    while (queue.length >= queueLimit && !cancelled && failure === undefined && !input.signal?.aborted)
      await new Promise<void>((resolve) => readersWaiting.push(resolve));
    if (cancelled || failure !== undefined || input.signal?.aborted) return;
    queue.push(value);
    wakeConsumer();
  };
  const readers = new Set<ReturnType<ReadableStream<Uint8Array>["getReader"]>>();
  const waitingReaders = new Set<ReturnType<ReadableStream<Uint8Array>["getReader"]>>();
  const drain = async (stream: ReadableStream<Uint8Array>, kind: ProcessStreamChunk["kind"]) => {
    const reader = stream.getReader();
    readers.add(reader);
    try {
      while (true) {
        waitingReaders.add(reader);
        const next = await reader.read();
        waitingReaders.delete(reader);
        if (next.done) break;
        const chunk = next.value;
        if (input.capture === true) budget({ kind, chunk });
        await enqueue({ kind, chunk });
      }
    } catch (cause) {
      if (!cancelled) {
        failure ??= { cause };
        proc.kill(input.capture === true ? "SIGKILL" : "SIGTERM");
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
  const closeIdleReaders = () => {
    if (queue.length === 0) for (const reader of waitingReaders) void reader.cancel().catch(() => undefined);
    if (readers.size > 0) drainTimer = setTimeout(closeIdleReaders, 1000);
  };
  void proc.exited.then(() => {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (!cancelled && readers.size > 0) drainTimer = setTimeout(closeIdleReaders, 1000);
  });
  const iterable: AsyncIterable<ProcessStreamEvent> = {
    async *[Symbol.asyncIterator]() {
      const checkStopped = () => {
        if (timedOut) throw timeoutError(input, DateTime.toEpochMillis(DateTime.nowUnsafe()) - startedAt);
        input.signal?.throwIfAborted();
      };
      while (!cancelled) {
        checkStopped();
        const value = queue.shift();
        if (value !== undefined) {
          wakeReaders();
          yield value;
          continue;
        }
        if (failure !== undefined) throw failure.cause;
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
    input.signal?.removeEventListener("abort", abort);
    abort();
    // Descendants may still hold the pipes. Reap the direct child without waiting for pipe EOF.
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    await Promise.all([stdoutReader, stderrReader]).finally(() => proc.exited);
  };
  return { iterable, close };
}
