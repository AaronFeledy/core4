import { type Context, Effect, Layer, Stream } from "effect";

import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import {
  EventService,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
  type ProcessStreamChunk,
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

const writeStdin = async (
  stdin: Bun.FileSink | null | undefined,
  input: string | Uint8Array | undefined,
): Promise<void> => {
  if (stdin === undefined || stdin === null || input === undefined) {
    return;
  }
  await stdin.write(typeof input === "string" ? textEncoder.encode(input) : input);
  await stdin.end();
};

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
    stdin: (input.stdin === undefined ? "ignore" : "pipe") as "ignore" | "pipe",
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
};

const acquireProcess = (input: ProcessSpawnOptions) =>
  Effect.try({
    try: () => Bun.spawn([input.cmd, ...input.args], buildSpawnOptions(input)),
    catch: (cause) => execError(input, cause),
  });

const releaseProcess = (proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">) =>
  Effect.promise(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
  });

const runProcess = (
  input: ProcessSpawnOptions,
): Effect.Effect<ProcessResult, ProcessExecError | ProcessTimeoutError> =>
  Effect.acquireUseRelease(
    acquireProcess(input),
    (proc) => {
      const startedAt = Date.now();
      const collect = Effect.tryPromise({
        try: async () => {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
            writeStdin(proc.stdin, input.stdin),
          ]);
          return { exitCode, stdout, stderr };
        },
        catch: (cause) => execError(input, cause),
      });
      return input.timeoutMs === undefined
        ? collect
        : collect.pipe(
            Effect.timeoutFail({
              duration: input.timeoutMs,
              onTimeout: () => timeoutError(input, Date.now() - startedAt),
            }),
          );
    },
    releaseProcess,
  );

const streamProcess = (input: ProcessSpawnOptions) =>
  Stream.acquireRelease(acquireProcess(input), releaseProcess).pipe(
    Stream.flatMap((proc) => {
      const startedAt = Date.now();
      const outputs = (["stdout", "stderr"] as const).map((kind) =>
        Stream.fromReadableStream({
          evaluate: () => proc[kind],
          onError: (cause) => execError(input, cause),
          // Release readers without awaiting pipe cancellation before the process finalizer can kill it.
          releaseLockOnEnd: true,
        }).pipe(Stream.map((chunk): ProcessStreamChunk => ({ kind, chunk }))),
      );
      const completion = Stream.fromEffect(
        Effect.tryPromise({
          try: () => Promise.all([writeStdin(proc.stdin, input.stdin), proc.exited]),
          catch: (cause) => execError(input, cause),
        }),
      ).pipe(Stream.drain);
      const output = Stream.mergeAll([...outputs, completion], { concurrency: 3, bufferSize: 16 });
      return input.timeoutMs === undefined
        ? output
        : output.pipe(
            Stream.interruptWhen(
              Effect.sleep(input.timeoutMs).pipe(
                Effect.zipRight(
                  Effect.suspend(() => Effect.fail(timeoutError(input, Date.now() - startedAt))),
                ),
              ),
            ),
          );
    }),
  );

const processRunnerService: Context.Tag.Service<typeof ProcessRunner> = {
  run: (input) =>
    Effect.gen(function* () {
      yield* publishRedactedProcessEvent(input, {
        _tag: "pre-process-exec",
        ...processEventShape(input),
      });
      const result = yield* runProcess(input).pipe(
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
    streamProcess(input).pipe(
      Stream.catchAll((error) =>
        Stream.fromEffect(redactProcessError(input, error).pipe(Effect.flatMap(Effect.fail))),
      ),
    ),
};

export const ProcessRunnerLive = Layer.succeed(ProcessRunner, processRunnerService);
