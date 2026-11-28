import { McpTransportError } from "@lando/sdk/errors";
import { Cause, Clock, Deferred, Duration, Effect, Pull, Semaphore, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import {
  MAX_FRAME_BYTES,
  OUTBOUND_WRITE_DEADLINE,
  PARTIAL_FRAME_DEADLINE,
  stdioTransportError,
} from "./stdio-limits";

const isJsonWhitespace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0d;

export const guardStdio = Effect.fnUntraced(function* (
  stdio: Stdio.Stdio,
  terminal: Deferred.Deferred<void, McpTransportError>,
) {
  let open = true;
  const close = Effect.sync(() => {
    open = false;
  });
  const lane = yield* Semaphore.make(1);
  const fail = (error: McpTransportError) =>
    close.pipe(Effect.andThen(Deferred.fail(terminal, error)), Effect.asVoid);
  const stdout: Stdio.Stdio["stdout"] = (options) =>
    forEachChunk((chunk: string | Uint8Array) =>
      lane.withPermits(1)(
        Effect.suspend(() =>
          open
            ? Stream.run(Stream.make(chunk), stdio.stdout(options)).pipe(
                Effect.timeoutOrElse({
                  duration: OUTBOUND_WRITE_DEADLINE,
                  orElse: () =>
                    Effect.fail(
                      stdioTransportError("MCP stdio stdout write exceeded the 5 second deadline."),
                    ),
                }),
                Effect.catch((cause) => fail(stdioTransportError(cause.message, { cause }))),
              )
            : Effect.void,
        ).pipe(Effect.uninterruptible),
      ),
    );
  const stdin = Stream.transformPull(stdio.stdin, (pull) =>
    Effect.sync(() => {
      let parts: Uint8Array[] = [];
      let size = 0;
      let startedAt: number | undefined;
      let blank = true;
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
                        stdioTransportError("MCP stdio partial frame exceeded the 5 second deadline.", {
                          remediation:
                            "Reconnect and write each JSON-RPC message with its terminating LF in one flush, within 5 seconds of its first byte.",
                        }),
                      ),
                  });
            const chunks = yield* Pull.catchDone(read, () =>
              Effect.gen(function* () {
                if (!blank) {
                  return yield* Effect.fail(
                    stdioTransportError("MCP stdio closed with an incomplete non-whitespace frame.", {
                      remediation: "End every JSON-RPC message with LF before closing stdin.",
                    }),
                  );
                }
                yield* close;
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
                    stdioTransportError("MCP stdio frame exceeded the 1 MiB inbound limit.", {
                      remediation:
                        "Reconnect and send each JSON-RPC message as one line of at most 1 MiB, including any CR before LF.",
                    }),
                  );
                }
                if (length > 0) {
                  if (startedAt === undefined) startedAt = yield* Clock.currentTimeMillis;
                  const part = chunk.slice(start, end);
                  parts.push(part);
                  size += length;
                  if (blank) blank = part.every(isJsonWhitespace);
                }
                if (end < chunk.length) {
                  if (!blank) {
                    const frame = new Uint8Array(size + 1);
                    let offset = 0;
                    for (const part of parts) {
                      frame.set(part, offset);
                      offset += part.length;
                    }
                    frame[size] = 10;
                    frames.push(frame);
                  }
                  parts = [];
                  size = 0;
                  startedAt = undefined;
                  blank = true;
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
              : stdioTransportError("MCP stdio input failed while reading a frame.", { cause: error });
          return fail(failure).pipe(Effect.andThen(Cause.done()));
        }),
      );
      return next();
    }),
  );
  return {
    close,
    stdio: Stdio.make({
      ...stdio,
      stdin,
      stdout,
    }),
  };
});
