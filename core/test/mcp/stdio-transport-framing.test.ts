import { describe, expect, test } from "bun:test";
import { Effect, Fiber, TestClock, TestContext } from "effect";

import type { McpCatalog } from "@lando/sdk/schema";

import { makeStdioMcpTransport } from "../../src/mcp/stdio-transport.ts";
import {
  expectMcpTransportFailure,
  expectPolledMcpTransportFailure,
} from "./stdio-transport-test-support.ts";

const encoder = new TextEncoder();
const catalog = { tools: [] } satisfies McpCatalog;

const inputFromChunks = (chunks: ReadonlyArray<string>, close: boolean): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJsonObject = (line: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(line);
  if (!isJsonObject(parsed)) {
    throw new Error("expected JSON-RPC line to decode to an object");
  }
  return parsed;
};

describe("makeStdioMcpTransport inbound framing limits", () => {
  test("stdio-oversized-frame-disconnects before parsing a frame over 1 MiB", async () => {
    // Given
    const writes: string[] = [];
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
      params: { padding: "x".repeat(1024 * 1024) },
    });
    const input = inputFromChunks([`${frame}\n`], true);

    // When
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Effect.sync(() => writes.push(line)),
        });
        return yield* transport.receive.pipe(Effect.exit);
      }).pipe(Effect.scoped),
    );

    // Then
    expectMcpTransportFailure(exit);
  });

  test("stdio-partial-frame-eof-disconnects without parsing the trailing buffer", async () => {
    // Given
    const writes: string[] = [];
    const input = inputFromChunks(
      [JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} })],
      true,
    );

    // When
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Effect.sync(() => writes.push(line)),
        });
        return yield* transport.receive.pipe(Effect.exit);
      }).pipe(Effect.scoped),
    );

    // Then
    expectMcpTransportFailure(exit);
  });

  test("stdio-malformed-frame-single-parse-error", async () => {
    // Given
    const writes: string[] = [];
    const input = inputFromChunks(
      [
        '{"jsonrpc":"2.0","id":12,"method":"tools/list",}\n',
        `${JSON.stringify({ jsonrpc: "2.0", id: 13, method: "tools/list", params: {} })}\n`,
      ],
      true,
    );

    // When
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Effect.sync(() => writes.push(line)),
        });
        return yield* transport.receive.pipe(Effect.exit);
      }).pipe(Effect.scoped),
    );

    // Then
    expect(writes.map(parseJsonObject)).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: null,
        error: expect.objectContaining({ code: -32700, message: "Parse error" }),
      }),
    ]);
    expectMcpTransportFailure(exit);
  });

  test("stdio-partial-frame-deadline-terminates", async () => {
    // Given
    const chunkRead = Promise.withResolvers<void>();
    let sent = false;
    const input = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (sent) return;
        sent = true;
        controller.enqueue(encoder.encode('{"jsonrpc":"2.0","id":14'));
        chunkRead.resolve();
      },
    });

    // When
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({ catalog, input, write: () => Effect.void });
        const receiveFiber = yield* transport.receive.pipe(Effect.fork);
        yield* Effect.promise(() => chunkRead.promise);
        yield* Effect.yieldNow();
        yield* TestClock.adjust("5 seconds");
        const poll = yield* Fiber.poll(receiveFiber);
        yield* Fiber.interrupt(receiveFiber);
        return poll;
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    );

    // Then
    expectPolledMcpTransportFailure(completion);
  });

  test("stdio-slow-loris-cannot-extend-the-partial-frame-deadline", async () => {
    // Given
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const input = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
    });
    if (controller === undefined) throw new Error("expected the input controller to be initialized");
    const inputController = controller;

    // When
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({ catalog, input, write: () => Effect.void });
        const receiveFiber = yield* transport.receive.pipe(Effect.fork);
        inputController.enqueue(encoder.encode('{"jsonrpc":"2.0"'));
        yield* Effect.yieldNow();
        yield* TestClock.adjust("4 seconds");
        inputController.enqueue(encoder.encode(',"id":15'));
        yield* Effect.yieldNow();
        yield* TestClock.adjust("1 second");
        const poll = yield* Fiber.poll(receiveFiber);
        yield* Fiber.interrupt(receiveFiber);
        return poll;
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    );

    // Then
    expectPolledMcpTransportFailure(completion);
  });
});
