import { type Context, Effect, Layer, Stream } from "effect";

import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import {
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
  type ProcessStreamChunk,
} from "@lando/sdk/services";

import { RedactionService } from "../redaction/service.ts";

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

const identityRedactor: Pick<Redactor, "redactString"> = { redactString: (text) => text };

const redactorForInput = (input: ProcessSpawnOptions) =>
  Effect.gen(function* () {
    const redaction = yield* Effect.serviceOption(RedactionService);
    if (redaction._tag === "None") return identityRedactor;
    return yield* redaction.value.forProfile("secrets", {
      sourceEnv: { ...process.env, ...(input.env ?? {}) },
    });
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
  end: () => void;
}

const writeStdin = (stdin: BunFileSink | null | undefined, input: string | Uint8Array | undefined): void => {
  if (stdin === undefined || stdin === null || input === undefined) {
    return;
  }
  stdin.write(typeof input === "string" ? textEncoder.encode(input) : input);
  stdin.end();
};

const buildSpawnOptions = (input: ProcessSpawnOptions) =>
  ({
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: { ...process.env, ...input.env } }),
    stdin: (input.stdin === undefined ? "ignore" : "pipe") as "ignore" | "pipe",
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  }) as const;

const runProcess = async (input: ProcessSpawnOptions): Promise<ProcessResult> => {
  const startedAt = Date.now();
  const proc = Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input));

  writeStdin(proc.stdin as BunFileSink | null | undefined, input.stdin);

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

  await Promise.race([proc.exited, timeoutGate]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timedOut) {
    throw timeoutError(input, Date.now() - startedAt);
  }

  return { exitCode, stdout, stderr };
};

async function* streamProcess(input: ProcessSpawnOptions): AsyncGenerator<ProcessStreamChunk> {
  const proc = Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input));

  writeStdin(proc.stdin as BunFileSink | null | undefined, input.stdin);

  // Interleave stdout and stderr via a shared async queue so that chunks are
  // yielded in arrival order and neither pipe can block the other.
  type Queued = { value: ProcessStreamChunk } | { done: true };
  const queue: Queued[] = [];
  const resolvers: Array<() => void> = [];

  const enqueue = (item: Queued): void => {
    queue.push(item);
    resolvers.shift()?.();
  };

  const dequeue = (): Promise<Queued> =>
    new Promise<Queued>((res) => {
      if (queue.length > 0) {
        res(queue.shift() as Queued);
      } else {
        resolvers.push(() => res(queue.shift() as Queued));
      }
    });

  let open = 2;
  const close = (): void => {
    if (--open === 0) enqueue({ done: true });
  };

  void (async () => {
    for await (const chunk of proc.stdout) enqueue({ value: { kind: "stdout", chunk } });
    close();
  })();

  void (async () => {
    for await (const chunk of proc.stderr) enqueue({ value: { kind: "stderr", chunk } });
    close();
  })();

  for (;;) {
    const item = await dequeue();
    if ("done" in item) break;
    yield item.value;
  }

  await proc.exited;
}

const processRunnerService: Context.Tag.Service<typeof ProcessRunner> = {
  run: (input) =>
    Effect.tryPromise({
      try: () => runProcess(input),
      catch: (cause) =>
        cause instanceof ProcessTimeoutError || cause instanceof ProcessExecError
          ? cause
          : execError(input, cause),
    }).pipe(Effect.catchAll((error) => Effect.flatMap(redactProcessError(input, error), Effect.fail))),
  stream: (input) =>
    Stream.fromAsyncIterable(streamProcess(input), (cause) => execError(input, cause)).pipe(
      Stream.catchAll((error) =>
        Stream.fromEffect(redactProcessError(input, error).pipe(Effect.flatMap(Effect.fail))),
      ),
    ),
};

export const ProcessRunnerLive = Layer.succeed(ProcessRunner, processRunnerService);
