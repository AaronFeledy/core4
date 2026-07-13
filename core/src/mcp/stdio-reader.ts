import { Clock, Deferred, Duration, Effect, Option, Queue } from "effect";

import type { McpTransportError } from "@lando/sdk/errors";

import {
  MAX_FRAME_BYTES,
  MAX_PARTIAL_BUFFER_BYTES,
  PARTIAL_FRAME_DEADLINE,
  stdioTransportError,
} from "./stdio-limits.ts";

export interface StdioReaderOptions {
  readonly reader: {
    readonly read: () => Promise<{
      readonly done: boolean;
      readonly value: Uint8Array | undefined;
    }>;
  };
  readonly terminal: Deferred.Deferred<void, McpTransportError>;
  readonly onFrame: (frame: string) => Effect.Effect<void, McpTransportError>;
}

const restoreTerminal = <A>(
  terminal: Effect.Effect<void, McpTransportError>,
): Effect.Effect<Option.Option<A>, McpTransportError> => terminal.pipe(Effect.as(Option.none<A>()));

export const takeUntilTerminal = <A>(
  queue: Queue.Queue<A>,
  terminal: Deferred.Deferred<void, McpTransportError>,
): Effect.Effect<Option.Option<A>, McpTransportError> =>
  Deferred.poll(terminal).pipe(
    Effect.flatMap((completed) => {
      if (Option.isSome(completed)) {
        return Queue.poll(queue).pipe(
          Effect.flatMap((queued) =>
            Option.isSome(queued) ? Effect.succeed(queued) : restoreTerminal<A>(completed.value),
          ),
        );
      }
      return Effect.raceFirst(
        Queue.take(queue).pipe(Effect.map(Option.some)),
        Deferred.await(terminal).pipe(
          Effect.exit,
          Effect.flatMap(() => takeUntilTerminal(queue, terminal)),
        ),
      );
    }),
  );

const readFailure = (cause: unknown): McpTransportError =>
  stdioTransportError("MCP stdio input failed while reading a frame.", cause);

const partialDeadlineFailure = (): McpTransportError =>
  stdioTransportError("MCP stdio partial frame exceeded the 5 second deadline.");

const frameSizeFailure = (): McpTransportError =>
  stdioTransportError("MCP stdio frame exceeded the 1 MiB inbound limit.");

const partialEofFailure = (): McpTransportError =>
  stdioTransportError("MCP stdio closed with an incomplete non-whitespace frame.");

export const runStdioReader = (options: StdioReaderOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let parts: Uint8Array[] = [];
    let bufferedBytes = 0;
    let frameStartedAt: number | undefined;

    const resetFrame = (): void => {
      parts = [];
      bufferedBytes = 0;
      frameStartedAt = undefined;
    };

    const append = (chunk: Uint8Array, start: number, end: number): Effect.Effect<void, McpTransportError> =>
      Effect.gen(function* () {
        const length = end - start;
        if (length === 0) return;
        if (frameStartedAt === undefined) frameStartedAt = yield* Clock.currentTimeMillis;
        if (bufferedBytes + length > MAX_FRAME_BYTES || bufferedBytes + length > MAX_PARTIAL_BUFFER_BYTES) {
          return yield* Effect.fail(frameSizeFailure());
        }
        parts.push(chunk.slice(start, end));
        bufferedBytes += length;
      });

    const emitFrame = Effect.gen(function* () {
      const bytes = new Uint8Array(bufferedBytes);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const frame = decoder.decode(bytes);
      resetFrame();
      if (frame.trim().length > 0) yield* options.onFrame(frame);
    });

    const readChunk = () =>
      Effect.gen(function* () {
        const read = Effect.tryPromise({
          try: () => options.reader.read(),
          catch: readFailure,
        });
        if (frameStartedAt === undefined) return yield* read;
        const now = yield* Clock.currentTimeMillis;
        const remaining = Duration.toMillis(PARTIAL_FRAME_DEADLINE) - (now - frameStartedAt);
        if (remaining <= 0) return yield* Effect.fail(partialDeadlineFailure());
        return yield* Effect.timeoutFail(read, {
          duration: Duration.millis(remaining),
          onTimeout: partialDeadlineFailure,
        });
      });

    while (true) {
      const result = yield* readChunk();
      if (result.done) {
        if (bufferedBytes > 0) {
          const bytes = new Uint8Array(bufferedBytes);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          if (decoder.decode(bytes).trim().length > 0) return yield* Effect.fail(partialEofFailure());
        }
        yield* Deferred.succeed(options.terminal, undefined);
        return;
      }

      const value = result.value;
      if (value === undefined) return yield* Effect.fail(readFailure("missing stream chunk"));

      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== 0x0a) continue;
        yield* append(value, start, index);
        yield* emitFrame;
        start = index + 1;
      }
      yield* append(value, start, value.length);
    }
  }).pipe(Effect.catchAll((error) => Deferred.fail(options.terminal, error).pipe(Effect.asVoid)));
