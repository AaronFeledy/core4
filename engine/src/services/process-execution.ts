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
  const proc = Bun.spawn(
    [input.cmd, ...input.args],
    buildSpawnOptions({ ...input, cwd: context.cwd, env: context.env }, captured.platform),
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
  execution: {
    readonly includeExitCode: boolean;
    readonly bunCommandEnv: boolean;
    readonly prepared?: { readonly cwd: string; readonly env: Readonly<Record<string, string>> };
  },
): AsyncGenerator<ProcessStreamEvent> {
  await using context =
    execution.prepared === undefined
      ? await prepareProcessSpawn(captured, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          bunCommandEnv: execution.bunCommandEnv,
        })
      : { ...execution.prepared, [Symbol.asyncDispose]: async () => {} };
  input.signal?.throwIfAborted();
  const proc = Bun.spawn(
    [input.cmd, ...input.args],
    buildSpawnOptions({ ...input, cwd: context.cwd, env: context.env }, captured.platform),
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
  const readersWaiting: Array<() => void> = [];
  const consumerWaiting: Array<() => void> = [];
  const wakeConsumer = () => {
    for (const wake of consumerWaiting.splice(0)) wake();
  };
  const wakeReaders = () => {
    for (const wake of readersWaiting.splice(0)) wake();
  };
  const abort = () => {
    proc.kill("SIGKILL");
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
    while (queue.length >= queueLimit && !cancelled && !failed)
      await new Promise<void>((resolve) => readersWaiting.push(resolve));
    if (cancelled || failed) return;
    queue.push(value);
    wakeConsumer();
  };
  const drain = async (stream: ReadableStream<Uint8Array>, kind: ProcessStreamChunk["kind"]) => {
    try {
      for await (const chunk of stream) {
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
      openReaders--;
      wakeConsumer();
    }
  };
  const stdoutReader = stdoutStream === undefined ? Promise.resolve() : drain(stdoutStream, "stdout");
  const stderrReader = stderrStream === undefined ? Promise.resolve() : drain(stderrStream, "stderr");
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
    proc.kill("SIGKILL");
    await proc.exited;
    if (input.capture === true) await Promise.all([stdoutReader, stderrReader]);
  }
}
