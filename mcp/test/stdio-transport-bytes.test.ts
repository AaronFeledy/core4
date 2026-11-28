import { expect, test } from "bun:test";
import type { McpTransportError } from "@lando/sdk/errors";
import { Deferred, Effect, Sink, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { guardStdio } from "../src/stdio-guard";

const encoder = new TextEncoder();

test("the guard filters blank frames and forwards content with original line endings", async () => {
  let writes = 0;
  const lines = await Effect.runPromise(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<void, McpTransportError>();
      const guard = yield* guardStdio(
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.make("  \r", "\n{ba", 'd}\r\n\n{"a"', ":1}\n\t").pipe(
            Stream.map((part) => encoder.encode(part)),
          ),
          stdout: () =>
            forEachChunk(() =>
              Effect.sync(() => {
                writes++;
              }),
            ),
          stderr: () => Sink.drain,
        }),
        terminal,
      );
      const frames = yield* Stream.runCollect(guard.stdio.stdin);
      yield* Deferred.await(terminal);
      const decoder = new TextDecoder();
      return frames.map((frame) => decoder.decode(frame));
    }),
  );
  expect(lines).toEqual(["{bad}\r\n", '{"a":1}\n']);
  expect(writes).toBe(0);
});
