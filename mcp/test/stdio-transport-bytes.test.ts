import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { makeStdioClient } from "@lando/mcp/testing";
import type { McpTransportError } from "@lando/sdk/errors";
import { Deferred, Effect, Fiber, Sink, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { guardStdio } from "../src/stdio-guard";
import { serverLayer, startServer } from "./server";
import { expectMcpTransportFailure } from "./stdio-transport-test-support";

const encoder = new TextEncoder();

test.each([false, true])("stdio rejects oversized blank input with final LF=%s", async (complete) => {
  const observed = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeStdioClient();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provide(client.layer), Effect.forkScoped);
      yield* client.raw(encoder.encode(" ".repeat(1_048_577) + (complete ? "\n" : "")));
      const exit = yield* Fiber.await(fiber);
      return { exit, messages: yield* client.messages };
    }).pipe(Effect.scoped, Effect.provide(serverLayer())),
  );
  expect(expectMcpTransportFailure(observed.exit)?.message).toBe(
    "MCP stdio frame exceeded the 1 MiB inbound limit.",
  );
  expect(observed.messages).toEqual([]);
});

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

test.each([
  { ending: "LF", overflow: 0 },
  { ending: "LF", overflow: 1 },
  { ending: "CRLF", overflow: 0 },
  { ending: "CRLF", overflow: 1 },
])("stdio counts bytes before $ending, overflow=$overflow", async ({ ending, overflow }) => {
  const head = '{"jsonrpc":"2.0","id":40,"method":"ping","params":{"padding":"';
  const tail = ending === "CRLF" ? '"}}\r' : '"}}';
  const bytes = encoder.encode(
    `${head}é${"x".repeat(1_048_576 + overflow - head.length - 2 - tail.length)}${tail}\n`,
  );
  const split = head.length + 1;
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* startServer();
      yield* client.raw(bytes.subarray(0, split));
      yield* client.raw(bytes.subarray(split));
      if (overflow === 0) {
        let reply = yield* client.next;
        while (reply.id !== 40) reply = yield* client.next;
        expect(reply).toEqual({ jsonrpc: "2.0", id: 40, result: {} });
        yield* client.close;
        yield* Fiber.join(client.fiber);
      } else {
        expect(expectMcpTransportFailure(yield* Fiber.await(client.fiber))?.message).toBe(
          "MCP stdio frame exceeded the 1 MiB inbound limit.",
        );
        expect((yield* client.messages).map((message) => message.id)).toEqual([1]);
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer()), Effect.timeout("4 seconds")),
  );
});
