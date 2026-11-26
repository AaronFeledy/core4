import { ProcessExecError, ServiceExecError } from "@lando/sdk/errors";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

export interface ExecStreamCompletion<E> {
  readonly signal?: AbortSignal | undefined;
  readonly failure: () => E;
}

const checkCommandEffects =
  "The command may have finished or may still be running. Check what it changed before running it again.";

export class UnobservedServiceExit extends ServiceExecError {
  constructor(providerId: string, service: string) {
    super({
      providerId,
      operation: "exec",
      service,
      message: "Container exec ended without an observed exit status.",
      remediation: checkCommandEffects,
    });
  }
}

export const execExitUnobserved = (providerId: string, service: string): ServiceExecError =>
  new UnobservedServiceExit(providerId, service);

export class UnobservedProcessExit extends ProcessExecError {
  constructor() {
    super({
      cmd: "[unreported]",
      message: "The process stream ended without an observed exit status.",
      remediation: checkCommandEffects,
    });
  }
}

export const processExitUnobserved = (): ProcessExecError => new UnobservedProcessExit();

export const requireObservedExit = <E>(
  exitCode: number | undefined,
  completion: ExecStreamCompletion<E>,
): Effect.Effect<number, E> => {
  if (exitCode !== undefined) return Effect.succeed(exitCode);
  return completion.signal?.aborted === true ? Effect.interrupt : Effect.fail(completion.failure());
};

export const drainExecStream = Effect.fnUntraced(function* <E, R, E2>(
  stream: Stream.Stream<ExecChunk, E, R>,
  write: (chunk: Exclude<ExecChunk, { readonly exitCode: number }>) => Effect.Effect<void>,
  completion: ExecStreamCompletion<E2>,
): Effect.fn.Return<number, E | E2, R> {
  let exitCode: number | undefined;
  yield* stream.pipe(
    Stream.runForEach((chunk) => {
      if ("exitCode" in chunk) {
        exitCode = chunk.exitCode;
        return Effect.void;
      }
      return write(chunk);
    }),
  );
  return yield* requireObservedExit(exitCode, completion);
});
