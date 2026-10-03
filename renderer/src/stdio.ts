import { Effect, Layer, PlatformError, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";

export interface StdioOptions {
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: (chunk: string | Uint8Array) => PromiseLike<unknown> | unknown;
  readonly stderr: (chunk: string | Uint8Array) => PromiseLike<unknown> | unknown;
  readonly args?: ReadonlyArray<string>;
}

const ioError = (method: string, cause: unknown) =>
  PlatformError.systemError({ _tag: "Unknown", module: "Stdio", method, cause });

export const make = (options: StdioOptions): Stdio.Stdio =>
  Stdio.make({
    args: Effect.succeed(options.args ?? []),
    stdin: Stream.fromReadableStream({
      evaluate: () => options.stdin,
      onError: (cause) => ioError("stdin", cause),
    }),
    stdout: () =>
      forEachChunk((chunk: string | Uint8Array) =>
        Effect.tryPromise({
          try: async () => {
            await options.stdout(chunk);
          },
          catch: (cause) => ioError("stdout", cause),
        }),
      ),
    stderr: () =>
      forEachChunk((chunk: string | Uint8Array) =>
        Effect.tryPromise({
          try: async () => {
            await options.stderr(chunk);
          },
          catch: (cause) => ioError("stderr", cause),
        }),
      ),
  });

export const layer = Layer.sync(Stdio.Stdio, () => {
  const stdout = Bun.stdout.writer();
  const stderr = Bun.stderr.writer();
  return make({
    stdin: Bun.stdin.stream(),
    args: Bun.argv,
    stdout: async (chunk) => {
      stdout.write(chunk);
      await stdout.flush();
    },
    stderr: async (chunk) => {
      stderr.write(chunk);
      await stderr.flush();
    },
  });
});
