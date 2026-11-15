import { CommandStdioError, DataTransferError } from "@lando/sdk/errors";
import { type Cause, Effect, Stream } from "effect";
import { collectDumpPrefix, detectDumpCompression } from "./compression.ts";
import { dumpTransferError } from "./dump-transfer-error.ts";

type DumpReadError = CommandStdioError | DataTransferError;

// Only rejected source reads create this carrier. Producer prefetch alone must never
// replace an independent staging or codec initialization failure.
class DumpSourceFailure extends Error {
  constructor(readonly sourceCause: Cause.Cause<CommandStdioError>) {
    super("SQL stdin source failed");
  }
}

export const openDumpSource = Effect.fn("Sql.openDumpSource")(function* (input: {
  readonly file: string;
  readonly stdin?: Stream.Stream<Uint8Array, CommandStdioError>;
}) {
  let producerCause: Cause.Cause<CommandStdioError> | undefined;
  let sourceFailure: DumpReadError | DumpSourceFailure | undefined;
  const readFailure = (cause: unknown): DumpReadError => {
    if (cause instanceof CommandStdioError || cause instanceof DataTransferError) return cause;
    return dumpTransferError("read", input.file, cause);
  };
  const bridgeFailure = (cause: unknown) => (cause instanceof DumpSourceFailure ? cause : readFailure(cause));
  const reader = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        (input.stdin === undefined
          ? Bun.file(input.file).stream()
          : Stream.toReadableStream(
              input.stdin.pipe(
                Stream.catchCause((cause) => {
                  producerCause = cause;
                  return Stream.failCause(cause);
                }),
              ),
            )
        ).getReader(),
      catch: readFailure,
    }),
    (owned) => Effect.promise(() => owned.cancel().catch(() => undefined)),
  );
  const read = async () => {
    try {
      return await reader.read();
    } catch (cause) {
      const error = producerCause === undefined ? readFailure(cause) : new DumpSourceFailure(producerCause);
      sourceFailure = error;
      throw error;
    }
  };
  const opened = yield* Effect.tryPromise({
    try: async () => {
      const pending: Uint8Array[] = [];
      let prefix: Uint8Array = new Uint8Array();
      while (prefix.byteLength < 4) {
        const next = await read();
        if (next.done) break;
        pending.push(next.value);
        prefix = collectDumpPrefix(next.value, prefix);
      }
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          const queued = pending.shift();
          if (queued !== undefined) {
            controller.enqueue(queued);
            return;
          }
          const next = await read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { compression: detectDumpCompression(prefix), body };
    },
    catch: bridgeFailure,
  }).pipe(
    Effect.catch((error) =>
      error instanceof DumpSourceFailure ? Effect.failCause(error.sourceCause) : Effect.fail(error),
    ),
  );

  return {
    ...opened,
    stream: <E>(body: ReadableStream<Uint8Array>, onError: (cause: unknown) => E) =>
      Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) => sourceFailure ?? onError(cause),
      }).pipe(
        Stream.catch((error) =>
          error instanceof DumpSourceFailure
            ? Stream.failCause<DumpReadError | E>(error.sourceCause)
            : Stream.fail<DumpReadError | E>(error),
        ),
      ),
    readFailure,
  };
});
