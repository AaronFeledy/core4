import { Chunk, Deferred, Effect, Queue, Ref, Scope } from "effect";

import { McpTransportError } from "@lando/sdk/errors";

import {
  MAX_OUTBOUND_QUEUED_BYTES,
  MAX_OUTBOUND_QUEUED_MESSAGES,
  OUTBOUND_WRITE_DEADLINE,
  stdioTransportError,
} from "./stdio-limits.ts";

interface OutboundMessage {
  readonly line: string;
  readonly bytes: number;
  readonly completed: Deferred.Deferred<void, McpTransportError>;
}

export interface StdioWriter {
  readonly write: (line: string) => Effect.Effect<void, McpTransportError>;
}

export interface StdioWriterOptions {
  readonly writeLine: (line: string) => Effect.Effect<void, unknown>;
  readonly terminal: Deferred.Deferred<void, McpTransportError>;
}

const writeDeadlineFailure = (): McpTransportError =>
  stdioTransportError("MCP stdio output remained blocked beyond the 5 second write deadline.");

const queueCapacityFailure = (): McpTransportError =>
  stdioTransportError("MCP stdio outbound queue exceeded its bounded capacity.");

const queuedBytesFailure = (): McpTransportError =>
  stdioTransportError("MCP stdio outbound queue exceeded the 8 MiB byte limit.");

export const makeStdioWriter = (
  options: StdioWriterOptions,
): Effect.Effect<StdioWriter, never, Scope.Scope> =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const queue = yield* Queue.dropping<OutboundMessage>(MAX_OUTBOUND_QUEUED_MESSAGES);
    const queuedBytes = yield* Ref.make(0);

    const failQueued = (error: McpTransportError): Effect.Effect<void> =>
      Queue.takeAll(queue).pipe(
        Effect.flatMap((messages) =>
          Effect.forEach(
            Chunk.toReadonlyArray(messages),
            (message) => Deferred.fail(message.completed, error),
            { discard: true },
          ),
        ),
      );

    const failTerminal = (error: McpTransportError): Effect.Effect<void> =>
      Deferred.fail(options.terminal, error).pipe(Effect.zipRight(failQueued(error)), Effect.asVoid);

    const terminalFailure = Deferred.await(options.terminal).pipe(
      Effect.matchEffect({
        onFailure: Effect.fail,
        onSuccess: () => Effect.never,
      }),
    );

    const worker = Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((message) =>
          Effect.raceFirst(
            Effect.timeoutFail(options.writeLine(message.line), {
              duration: OUTBOUND_WRITE_DEADLINE,
              onTimeout: writeDeadlineFailure,
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof McpTransportError
                  ? cause
                  : stdioTransportError("MCP stdio output write failed.", cause),
              ),
            ),
            terminalFailure,
          ).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Ref.update(queuedBytes, (current) => current - message.bytes).pipe(
                  Effect.zipRight(Deferred.fail(message.completed, error)),
                  Effect.zipRight(failTerminal(error)),
                ),
              onSuccess: () =>
                Ref.update(queuedBytes, (current) => current - message.bytes).pipe(
                  Effect.zipRight(Deferred.succeed(message.completed, undefined)),
                ),
            }),
          ),
        ),
      ),
    );
    yield* worker.pipe(Effect.forkScoped);

    yield* Deferred.await(options.terminal).pipe(
      Effect.catchAll((error) => failQueued(error)),
      Effect.forkScoped,
    );

    const write = (line: string): Effect.Effect<void, McpTransportError> =>
      Effect.gen(function* () {
        const bytes = encoder.encode(line).byteLength;
        const reserved = yield* Ref.modify(queuedBytes, (current) =>
          current + bytes > MAX_OUTBOUND_QUEUED_BYTES ? [false, current] : [true, current + bytes],
        );
        if (!reserved) {
          const error = queuedBytesFailure();
          yield* failTerminal(error);
          return yield* Effect.fail(error);
        }
        const completed = yield* Deferred.make<void, McpTransportError>();
        const accepted = yield* Queue.offer(queue, { line, bytes, completed });
        if (!accepted) {
          const error = queueCapacityFailure();
          yield* Ref.update(queuedBytes, (current) => current - bytes);
          yield* failTerminal(error);
          return yield* Effect.fail(error);
        }
        return yield* Deferred.await(completed);
      });

    yield* Scope.addFinalizer(yield* Effect.scope, Queue.shutdown(queue));
    return { write };
  });
