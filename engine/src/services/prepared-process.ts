import { FileIoError } from "@lando/sdk/errors";
import { ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Context, Effect } from "effect";
import { createBunCommandEnv } from "./bun-command-env.ts";
import {
  type CapturedHostExecutionContext,
  captureHostExecutionContext,
  prepareHostExecutionContext,
} from "./host-execution-context.ts";

export interface PreparedProcess {
  readonly observation: "caller-owned";
  readonly request: ProcessSpawnOptions;
  readonly context: CapturedHostExecutionContext;
  readonly spawn: { readonly cwd: string; readonly env: Readonly<Record<string, string>> };
}

// Identity, not a flag: unrelated nested requests still use the ordinary runner path.
export const PreparedProcessBinding = Context.Reference<PreparedProcess | undefined>(
  "@lando/engine/PreparedProcessBinding",
  { defaultValue: () => undefined },
);

export const withPreparedProcess = <A, E, R>(
  input: ProcessSpawnOptions,
  use: (
    runner: Context.Service.Shape<typeof ProcessRunner>,
    request: ProcessSpawnOptions,
  ) => Effect.Effect<A, E, R>,
  captured?: CapturedHostExecutionContext,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const snapshot = {
        ...input,
        args: [...input.args],
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
      };
      const context = captured ?? captureHostExecutionContext(snapshot);
      const runtime = context.runtime;
      const tempRoot = runtime.tempRoot;
      const runner = yield* ProcessRunner;
      const prepared = yield* Effect.tryPromise({
        try: async (signal) => {
          signal.throwIfAborted();
          snapshot.signal?.throwIfAborted();
          const prepared = await prepareHostExecutionContext(context);
          signal.throwIfAborted();
          snapshot.signal?.throwIfAborted();
          return prepared;
        },
        catch: (cause) =>
          cause instanceof FileIoError
            ? cause
            : new FileIoError({
                message: "Could not prepare the host working directory.",
                path: context.requestedCwd,
                cause,
                remediation: "Check that the requested working directory exists and is accessible.",
              }),
      });
      const launcher = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async (signal) => {
            signal.throwIfAborted();
            snapshot.signal?.throwIfAborted();
            const launcher = await createBunCommandEnv({ command: "lando", ...prepared, tempRoot }, runtime);
            if (signal.aborted || snapshot.signal?.aborted) {
              await launcher[Symbol.asyncDispose]();
              signal.throwIfAborted();
              snapshot.signal?.throwIfAborted();
            }
            return { ...launcher, cwd: prepared.cwd };
          },
          catch: (cause) =>
            cause instanceof FileIoError
              ? cause
              : new FileIoError({
                  message: "Could not prepare the private Bun execution directory.",
                  path: tempRoot,
                  cause,
                  remediation:
                    "Check that the working directory exists and the temporary directory is writable.",
                }),
        }),
        (launcher) => Effect.promise(() => launcher[Symbol.asyncDispose]()),
      );
      const request: ProcessSpawnOptions = { ...snapshot, cwd: launcher.cwd, env: launcher.env };
      return yield* use(runner, request).pipe(
        Effect.provideService(PreparedProcessBinding, {
          request,
          context,
          observation: "caller-owned",
          spawn: { cwd: launcher.cwd, env: launcher.env },
        }),
      );
    }),
  );
