import { type Context, Effect, Layer, Stream } from "effect";

import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import {
  EventService,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
  type ProcessStreamChunk,
  type ProcessStreamEvent,
} from "@lando/sdk/services";
import type { LandoEvent } from "@lando/sdk/services";

import { RedactionService } from "@lando/redaction/service";

const textEncoder = new TextEncoder();

const errnoFrom = (cause: unknown): number | undefined => {
  if (typeof cause === "object" && cause !== null && "errno" in cause) {
    const errno = (cause as { errno: unknown }).errno;
    return typeof errno === "number" ? errno : undefined;
  }
  return undefined;
};

const execError = (input: ProcessSpawnOptions, cause: unknown): ProcessExecError => {
  const errno = errnoFrom(cause);
  return new ProcessExecError({
    message: cause instanceof Error ? cause.message : `Failed to run ${input.cmd}`,
    cmd: input.cmd,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(errno === undefined ? {} : { errno }),
    cause,
  });
};

const timeoutError = (input: ProcessSpawnOptions, elapsedMs: number): ProcessTimeoutError =>
  new ProcessTimeoutError({
    message: `Process timed out after ${elapsedMs}ms: ${input.cmd}`,
    cmd: input.cmd,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    elapsedMs,
  });

type RuntimeRedactor = Pick<Redactor, "redactString" | "redactValue">;

const identityRedactor: RuntimeRedactor = { redactString: (text) => text, redactValue: (value) => value };

const redactorForInput = (input: ProcessSpawnOptions) =>
  Effect.gen(function* () {
    const redaction = yield* Effect.serviceOption(RedactionService);
    if (redaction._tag === "None") return identityRedactor;
    return yield* redaction.value.forProfile("secrets", {
      sourceEnv: { ...process.env, ...(input.env ?? {}) },
    });
  });

const publishProcessEvent = (event: LandoEvent): Effect.Effect<void> =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event).pipe(Effect.ignore) : Effect.void,
    ),
  );

const redactProcessEvent = (input: ProcessSpawnOptions, event: LandoEvent) =>
  Effect.gen(function* () {
    const redactor = yield* redactorForInput(input);
    return redactor.redactValue(event) as LandoEvent;
  });

const publishRedactedProcessEvent = (input: ProcessSpawnOptions, event: LandoEvent) =>
  Effect.serviceOption(RedactionService).pipe(
    Effect.flatMap((redaction) => {
      if (redaction._tag === "None") return Effect.void;
      return redactProcessEvent(input, event).pipe(Effect.flatMap(publishProcessEvent));
    }),
  );

const processEventShape = (input: ProcessSpawnOptions) => ({
  cmd: input.cmd,
  args: [...input.args],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: { ...input.env } }),
});

const redactProcessError = (input: ProcessSpawnOptions, error: ProcessExecError | ProcessTimeoutError) =>
  Effect.gen(function* () {
    const redactor = yield* redactorForInput(input);
    if (error instanceof ProcessTimeoutError) {
      return new ProcessTimeoutError({
        message: redactor.redactString(error.message),
        cmd: redactor.redactString(error.cmd),
        ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
        elapsedMs: error.elapsedMs,
      });
    }
    return new ProcessExecError({
      message: redactor.redactString(error.message),
      cmd: redactor.redactString(error.cmd),
      ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
      ...(error.errno === undefined ? {} : { errno: error.errno }),
      cause: error.cause,
    });
  });

interface BunFileSink {
  write: (chunk: string | Uint8Array) => number;
  flush?: () => number | Promise<number>;
  end: () => number | Promise<number>;
}

/**
 * Linux-only cgroup pass-through. Non-Linux platforms ignore `cgroup` so
 * callers can set it unconditionally. Do not throw a tagged "unsupported"
 * error on macOS / Windows.
 */
export const resolveProcessCgroup = (
  cgroup: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined => (platform === "linux" && cgroup !== undefined && cgroup !== "" ? cgroup : undefined);

const buildSpawnOptions = (input: ProcessSpawnOptions) => {
  const cgroup = resolveProcessCgroup(input.cgroup);
  return {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: { ...process.env, ...input.env } }),
    ...(cgroup === undefined ? {} : { cgroup }),
    stdin: (input.stdin === undefined && input.stdinStream === undefined ? "ignore" : "pipe") as
      | "ignore"
      | "pipe",
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
};

const isBrokenPipe = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPIPE";

export const awaitSinkResult = async (
  result: number | Promise<number>,
  exited: Promise<number>,
): Promise<void> => {
  const settled = Promise.resolve(result).then(
    () => ({ kind: "settled" as const }),
    (cause: unknown) => ({ kind: "failed" as const, cause }),
  );
  const first = await Promise.race([settled, exited.then(() => ({ kind: "exited" as const }))]);
  // Exit can win just before Bun rejects the sink. Observe that rejection without waiting forever.
  const outcome =
    first.kind === "exited"
      ? await Promise.race([settled, Bun.sleep(25).then(() => ({ kind: "pending" as const }))])
      : first;
  if (outcome.kind === "failed") throw outcome.cause;
};

const pumpStdin = async (
  sink: BunFileSink | null | undefined,
  input: ProcessSpawnOptions,
  exited: Promise<number>,
  hasExited: () => boolean,
): Promise<void> => {
  if (sink === undefined || sink === null) return;
  // Bun can report EPIPE just before its child-exit promise settles. Bound that check so a live child still fails.
  const exitedAfterBrokenPipe = async (): Promise<boolean> =>
    hasExited() || (await Promise.race([exited.then(() => true), Bun.sleep(25).then(() => false)]));
  if (input.stdinStream === undefined) {
    if (input.stdin === undefined) return;
    try {
      sink.write(typeof input.stdin === "string" ? textEncoder.encode(input.stdin) : input.stdin);
      const flushed = sink.flush?.();
      if (flushed !== undefined) await awaitSinkResult(flushed, exited);
      await awaitSinkResult(sink.end(), exited);
    } catch (cause) {
      if (!isBrokenPipe(cause) || !(await exitedAfterBrokenPipe())) throw cause;
    }
    return;
  }

  const iterator = input.stdinStream[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      const next = await Promise.race([
        iterator.next().then((value) => ({ kind: "chunk" as const, value })),
        exited.then(() => ({ kind: "exited" as const })),
      ]);
      if (next.kind === "exited") return;
      if (next.value.done) {
        finished = true;
        try {
          await awaitSinkResult(sink.end(), exited);
        } catch (cause) {
          if (!isBrokenPipe(cause) || !(await exitedAfterBrokenPipe())) throw cause;
        }
        return;
      }
      if (input.signal?.aborted) throw new DOMException("Process aborted.", "AbortError");
      try {
        sink.write(next.value.value);
        const flushed = sink.flush?.();
        if (flushed !== undefined) await awaitSinkResult(flushed, exited);
      } catch (cause) {
        if (!isBrokenPipe(cause) || !(await exitedAfterBrokenPipe())) throw cause;
        return;
      }
    }
  } finally {
    if (!finished) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // Child exit owns completion; a failed iterator close must not mask it.
      }
    }
  }
};

const runProcess = async (
  input: ProcessSpawnOptions,
  effectSignal?: AbortSignal,
  observeExit?: (exited: Promise<number>) => void,
): Promise<ProcessResult> => {
  const startedAt = Date.now();
  const signal =
    input.signal === undefined
      ? effectSignal
      : effectSignal === undefined
        ? input.signal
        : AbortSignal.any([input.signal, effectSignal]);
  if (signal?.aborted) throw new DOMException("Process aborted.", "AbortError");
  const proc = Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input));
  observeExit?.(proc.exited);
  const abort = () => proc.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });

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
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const stdinPump = pumpStdin(
    proc.stdin as BunFileSink | null | undefined,
    input,
    proc.exited,
    () => typeof proc.exitCode === "number",
  );
  try {
    await Promise.race([proc.exited, timeoutGate, stdinPump.then(() => proc.exited)]);
    if (timedOut) throw timeoutError(input, Date.now() - startedAt);
    if (signal?.aborted) throw new DOMException("Process aborted.", "AbortError");
    await stdinPump;
    const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
    return { exitCode, stdout, stderr };
  } catch (cause) {
    proc.kill("SIGKILL");
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (timedOut || signal?.aborted) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
};

async function* streamProcess(
  input: ProcessSpawnOptions,
  includeExitCode = false,
): AsyncGenerator<ProcessStreamEvent> {
  if (input.signal?.aborted) throw new DOMException("Process aborted.", "AbortError");
  const proc = Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input));
  const startedAt = Date.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdinPump = pumpStdin(
    proc.stdin as BunFileSink | null | undefined,
    input,
    proc.exited,
    () => typeof proc.exitCode === "number",
  );
  void stdinPump.catch(() => proc.kill());

  // Each reader stops at the queue limit until the consumer advances. A failed
  // reader wakes the consumer and preserves the original pipe error.
  const queue: ProcessStreamChunk[] = [];
  const queueLimit = 16;
  let openReaders = 2;
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
      for await (const chunk of stream) await enqueue({ kind, chunk });
    } catch (cause) {
      if (!failed) {
        failed = true;
        failure = cause;
      }
      proc.kill();
      wakeReaders();
    } finally {
      openReaders--;
      wakeConsumer();
    }
  };
  const stdoutReader = drain(proc.stdout, "stdout");
  const stderrReader = drain(proc.stderr, "stderr");

  try {
    for (;;) {
      if (timedOut) throw timeoutError(input, Date.now() - startedAt);
      if (input.signal?.aborted) throw new DOMException("Process aborted.", "AbortError");
      if (queue.length > 0) {
        const value = queue.shift() as ProcessStreamChunk;
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
    if (input.signal?.aborted) throw new DOMException("Process aborted.", "AbortError");
    if (includeExitCode) yield { exitCode };
  } finally {
    cancelled = true;
    wakeReaders();
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

const scopedProcessStream = (input: ProcessSpawnOptions, includeExitCode: boolean) =>
  Stream.unwrapScoped(
    Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    ).pipe(
      Effect.map((controller) => {
        const signal =
          input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
        const iterator = streamProcess({ ...input, signal }, includeExitCode);
        const iterable: AsyncIterable<ProcessStreamEvent> = {
          [Symbol.asyncIterator]: () => ({
            next: () => iterator.next(),
            return: () => {
              controller.abort();
              return iterator.return(undefined);
            },
          }),
        };
        return Stream.fromAsyncIterable(iterable, (cause) =>
          cause instanceof ProcessTimeoutError ? cause : execError(input, cause),
        );
      }),
    ),
  );

const processRunnerService: Context.Tag.Service<typeof ProcessRunner> = {
  run: (input) =>
    Effect.gen(function* () {
      yield* publishRedactedProcessEvent(input, {
        _tag: "pre-process-exec",
        ...processEventShape(input),
      });
      let childExit: Promise<number> | undefined;
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          runProcess(input, signal, (exited) => {
            childExit = exited;
          }),
        catch: (cause) =>
          cause instanceof ProcessTimeoutError || cause instanceof ProcessExecError
            ? cause
            : execError(input, cause),
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.promise(async () => {
            await childExit?.catch(() => undefined);
          }),
        ),
        Effect.catchAll((error) => Effect.flatMap(redactProcessError(input, error), Effect.fail)),
      );
      yield* publishRedactedProcessEvent(input, {
        _tag: "post-process-exec",
        ...processEventShape(input),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return result;
    }),
  stream: (input) =>
    scopedProcessStream(input, false).pipe(
      Stream.filter((event): event is ProcessStreamChunk => "kind" in event),
      Stream.catchAll((error) =>
        Stream.fromEffect(redactProcessError(input, error).pipe(Effect.flatMap(Effect.fail))),
      ),
    ),
  streamWithExit: (input) =>
    scopedProcessStream(input, true).pipe(
      Stream.catchAll((error) =>
        Stream.fromEffect(redactProcessError(input, error).pipe(Effect.flatMap(Effect.fail))),
      ),
    ),
};

export const ProcessRunnerLive = Layer.succeed(ProcessRunner, processRunnerService);
