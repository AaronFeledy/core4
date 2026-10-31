import { ProcessExecError, type ProcessTimeoutError } from "@lando/sdk/errors";
import {
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
  type ProcessStreamEvent,
} from "@lando/sdk/services";
import { Effect, Stream } from "effect";

export const unexpectedBun = async (): Promise<never> => {
  throw new TypeError("Unexpected Bun execution");
};

export const processRunnerFor = (
  execute: (
    input: ProcessSpawnOptions,
  ) => Effect.Effect<
    Pick<ProcessResult, "exitCode"> & Partial<ProcessResult>,
    ProcessExecError | ProcessTimeoutError
  >,
): ProcessRunner["Service"] => {
  const run: ProcessRunner["Service"]["run"] = (input) =>
    execute(input).pipe(Effect.map((result) => ({ stdout: "", stderr: "", ...result })));
  const streamWithExit = (input: ProcessSpawnOptions) =>
    Stream.unwrap(
      run(input).pipe(
        Effect.map((result) => {
          const frames: ProcessStreamEvent[] = [];
          if (result.stdout !== "")
            frames.push({ kind: "stdout", chunk: new TextEncoder().encode(result.stdout) });
          if (result.stderr !== "")
            frames.push({ kind: "stderr", chunk: new TextEncoder().encode(result.stderr) });
          frames.push({ exitCode: result.exitCode });
          return Stream.fromIterable(frames);
        }),
      ),
    );
  return ProcessRunner.of({
    run,
    streamWithExit,
    stream: (input) => streamWithExit(input).pipe(Stream.filter((event) => "kind" in event)),
  });
};

export const withProcess = (
  execute: (request: {
    readonly cmd: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }) => Promise<Pick<ProcessResult, "exitCode"> & Partial<ProcessResult>>,
) =>
  Effect.provideService(
    ProcessRunner,
    processRunnerFor((input) =>
      Effect.suspend(() => {
        let pending: Promise<Pick<ProcessResult, "exitCode"> & Partial<ProcessResult>> | undefined;
        return Effect.tryPromise({
          try: (signal) => {
            pending = execute({
              cmd: [input.cmd, ...input.args],
              cwd: input.cwd ?? "",
              env: input.env ?? {},
              signal,
            });
            return pending;
          },
          catch: (cause) =>
            new ProcessExecError({
              cmd: input.cmd,
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
              remediation: "Check child execution.",
            }),
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.promise(async () => {
              if (pending !== undefined) await Promise.allSettled([pending]);
            }),
          ),
        );
      }),
    ),
  );
