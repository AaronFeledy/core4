import { Cause, Effect, Exit } from "effect";

export interface RunWithErrorHandlingOptions<A> {
  readonly render?: (value: A) => string | undefined;
  readonly formatError: (error: unknown) => string;
  readonly failureMode?: "stderr" | "throw";
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export const runWithErrorHandling = async <A, E>(
  effect: Effect.Effect<A, E, never>,
  options: RunWithErrorHandlingOptions<A>,
): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    const rendered = options.render?.(exit.value);
    if (rendered !== undefined && rendered.length > 0) (options.stdout ?? console.log)(rendered);
    return;
  }

  const failure = Cause.failureOption(exit.cause);
  const message = failure._tag === "Some" ? options.formatError(failure.value) : Cause.pretty(exit.cause);
  if (options.failureMode === "throw") throw new Error(message);
  (options.stderr ?? console.error)(message);
  process.exitCode = 1;
};
