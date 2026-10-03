import { McpTransportError } from "@lando/sdk/errors";
import { Cause, Clock, Deferred, Duration, Effect, Pull, Stdio, Stream } from "effect";
import { Schema } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { ParseError } from "effect/ai/McpSchema";
import {
  MAX_FRAME_BYTES,
  OUTBOUND_WRITE_DEADLINE,
  PARTIAL_FRAME_DEADLINE,
  stdioTransportError,
} from "./stdio-limits";

export const guardStdio = Effect.fnUntraced(function* (
  stdio: Stdio.Stdio,
  terminal: Deferred.Deferred<void, McpTransportError>,
) {
  const stdout: Stdio.Stdio["stdout"] = (options) => forEachChunk((chunk: string | Uint8Array) =>
    Stream.run(Stream.make(chunk), stdio.stdout(options)).pipe(
      Effect.timeoutOrElse({ duration: OUTBOUND_WRITE_DEADLINE, orElse: () => Effect.fail(stdioTransportError("MCP stdio stdout write exceeded the 5 second deadline.")) }),
      Effect.catch((error) => Deferred.fail(terminal, stdioTransportError(error.message, error)).pipe(Effect.asVoid)),
    ));
  const stdin = Stream.transformPull(stdio.stdin, (pull) =>
    Effect.sync(() => {
      let parts: Uint8Array[] = [];
      let size = 0;
      let startedAt: number | undefined;
      const joined = () => {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        return bytes;
      };
      const next = Effect.fnUntraced(
        function* () {
          while (true) {
            const read =
              startedAt === undefined
                ? pull
                : Effect.timeoutOrElse(pull, {
                    duration: Duration.millis(
                      Math.max(
                        0,
                        Duration.toMillis(PARTIAL_FRAME_DEADLINE) -
                          ((yield* Clock.currentTimeMillis) - startedAt),
                      ),
                    ),
                    orElse: () =>
                      Effect.fail(
                        stdioTransportError("MCP stdio partial frame exceeded the 5 second deadline."),
                      ),
                  });
            const chunks = yield* Pull.catchDone(read, () =>
              Effect.gen(function* () {
                if (size > 0 && new TextDecoder().decode(joined()).trim().length > 0) {
                  return yield* Effect.fail(
                    stdioTransportError("MCP stdio closed with an incomplete non-whitespace frame."),
                  );
                }
                yield* Deferred.succeed(terminal, undefined);
                return yield* Cause.done();
              }),
            );
            const frames: Uint8Array[] = [];
            for (const chunk of chunks) {
              let start = 0;
              for (let end = 0; end <= chunk.length; end++) {
                if (end < chunk.length && chunk[end] !== 10) continue;
                const length = end - start;
                if (size + length > MAX_FRAME_BYTES) {
                  return yield* Effect.fail(
                    stdioTransportError("MCP stdio frame exceeded the 1 MiB inbound limit."),
                  );
                }
                if (length > 0) {
                  if (startedAt === undefined) startedAt = yield* Clock.currentTimeMillis;
                  parts.push(chunk.slice(start, end));
                  size += length;
                }
                if (end < chunk.length) {
                  const frame = new Uint8Array(size + 1);
                  frame.set(joined());
                  frame[size] = 10;
                  const text = new TextDecoder().decode(frame);
                  if (text.trim().length > 0) {
                    const parsed = yield* Effect.result(Effect.try(() => JSON.parse(text)));
                    if (parsed._tag === "Failure") {
                      const error = Schema.encodeSync(ParseError)(new ParseError({ message: "Parse error" }));
                      yield* Stream.run(
                        Stream.make(`${JSON.stringify({ jsonrpc: "2.0", id: null, error })}\n`),
                        stdout(),
                      );
                      return yield* Effect.fail(
                        stdioTransportError("MCP stdio received a malformed JSON frame."),
                      );
                    }
                  }
                  frames.push(frame);
                  parts = [];
                  size = 0;
                  startedAt = undefined;
                }
                start = end + 1;
              }
            }
            const first = frames[0];
            if (first !== undefined) return [first, ...frames.slice(1)] as const;
          }
        },
        Effect.catch((error) => {
          if (Cause.isDone(error)) return Effect.fail(error);
          const failure =
            error instanceof McpTransportError
              ? error
              : stdioTransportError("MCP stdio input failed while reading a frame.", error);
          return Deferred.fail(terminal, failure).pipe(Effect.andThen(Cause.done()));
        }),
      );
      return next();
    }),
  );
  return Stdio.make({
    ...stdio,
    stdin,
    stdout,
  });
});
