import { REDACTED } from "@lando/sdk/secrets";
import { EventService, type ProcessResult, type ProcessRunner } from "@lando/sdk/services";
import { Context, Effect, Redactable } from "effect";

export const OP_READ_TIMEOUT_MS = 120_000;

export type OpResult = ProcessResult & {
  readonly timedOut: boolean;
  readonly cliMissing?: boolean;
};

export type OpRunner = (
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Effect.Effect<OpResult>;

export const makeOpRunner = (runner: Pick<Context.Service.Shape<typeof ProcessRunner>, "run">): OpRunner =>
  Effect.fn("OnePassword.read")(
    (args: ReadonlyArray<string>, options: Parameters<OpRunner>[1]) =>
      runner.run({ cmd: "op", args, ...options }),
    // Process output contains secrets not yet registered with the redactor.
    Effect.updateContext((context: Context.Context<never>) => Context.omit(EventService)(context)),
    Effect.map((result): OpResult => ({ ...result, timedOut: false })),
    Effect.catchTags({
      ProcessTimeoutError: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
      ProcessExecError: (error) => {
        const cause = error.cause;
        const cliMissing =
          error.errno === -2 ||
          error.errno === 2 ||
          (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") ||
          /ENOENT|executable not found|command not found|no such file or directory/i.test(error.message);
        return Effect.succeed({ exitCode: 1, stdout: "", stderr: "", timedOut: false, cliMissing });
      },
    }),
    Effect.map((result) => ({
      ...result,
      [Redactable.symbolRedactable]: () => REDACTED,
      [Symbol.for("nodejs.util.inspect.custom")]: () => REDACTED,
      toJSON: () => REDACTED,
      toString: () => REDACTED,
    })),
  );
