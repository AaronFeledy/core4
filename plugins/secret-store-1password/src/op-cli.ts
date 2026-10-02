import { EventService, type ProcessResult, type ProcessRunner } from "@lando/sdk/services";
import { Context, Effect } from "effect";

export const OP_READ_TIMEOUT_MS = 120_000;

export type OpResult = ProcessResult & {
  readonly timedOut: boolean;
  readonly cliMissing?: boolean;
};

export type OpRunner = (
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Effect.Effect<OpResult>;

export const makeOpRunner =
  (runner: Pick<Context.Tag.Service<typeof ProcessRunner>, "run">): OpRunner =>
  (args, options) =>
    runner.run({ cmd: "op", args, ...options }).pipe(
      // Process output contains secrets not yet registered with the redactor.
      Effect.mapInputContext((context: Context.Context<never>) => Context.omit(EventService)(context)),
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
    );
