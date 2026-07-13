import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Option, TestClock, TestContext } from "effect";

import type { McpCatalog } from "@lando/sdk/schema";

import { makeStdioMcpTransport } from "../../src/mcp/stdio-transport.ts";
import {
  expectMcpTransportFailure,
  expectPolledMcpTransportFailure,
} from "./stdio-transport-test-support.ts";

const encoder = new TextEncoder();
const catalog = { tools: [] } satisfies McpCatalog;

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJsonObject = (line: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(line);
  if (!isJsonObject(parsed)) throw new Error("expected JSON-RPC line to decode to an object");
  return parsed;
};

const inputFromMessages = (messages: ReadonlyArray<unknown>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(
        encoder.encode(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`),
      );
      controller.close();
    },
  });

const openToolCallInput = (id: number, progressToken?: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "app:info",
              ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
            },
          })}\n`,
        ),
      );
    },
  });

describe("makeStdioMcpTransport queue and write limits", () => {
  test("stdio-outbound-deadline-disconnects", async () => {
    // Given
    const input = openToolCallInput(15);

    // When
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: () =>
            Deferred.succeed(writeStarted, undefined).pipe(Effect.zipRight(Deferred.await(releaseWrite))),
        });
        const incoming = yield* transport.receive;
        if (Option.isNone(incoming)) return Option.none();
        const replyFiber = yield* transport
          .reply({
            id: incoming.value.id,
            ok: true,
            result: { envelope: { apiVersion: "v4", command: "app:info", ok: true }, ok: true },
          })
          .pipe(Effect.fork);
        yield* Deferred.await(writeStarted);
        yield* TestClock.adjust("5 seconds");
        const poll = yield* Fiber.poll(replyFiber);
        yield* Fiber.interrupt(replyFiber);
        return poll;
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    );

    // Then
    expectPolledMcpTransportFailure(completion);
  });

  test("stdio-never-reading-client-cannot-accumulate-unbounded-progress", async () => {
    // Given
    const input = openToolCallInput(16, "blocked-progress");

    // When
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: () =>
            Deferred.succeed(writeStarted, undefined).pipe(Effect.zipRight(Deferred.await(releaseWrite))),
        });
        const incoming = yield* transport.receive;
        if (Option.isNone(incoming)) return yield* Effect.die(new Error("expected an open MCP tool call"));
        const notifications = Effect.forEach(
          Array.from({ length: 1026 }, (_, index) => index),
          (index) =>
            transport.notify({
              id: incoming.value.id,
              frame: { _tag: "output", stream: "stdout", line: `progress-${index}` },
            }),
          { concurrency: "unbounded", discard: true },
        );
        const notifyFiber = yield* notifications.pipe(Effect.fork);
        yield* Deferred.await(writeStarted);
        return yield* Fiber.await(notifyFiber);
      }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    );

    // Then
    const error = expectMcpTransportFailure(completion);
    expect(error?.message).toBe("MCP stdio outbound queue exceeded its bounded capacity.");
  });

  test("stdio-outbound-byte-cap-disconnects above 8 MiB", async () => {
    // Given
    const input = openToolCallInput(17, "oversized-progress");

    // When
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        let writeCalls = 0;
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: () =>
            Effect.sync(() => {
              writeCalls += 1;
            }),
        });
        const incoming = yield* transport.receive;
        if (Option.isNone(incoming)) return { completion: Option.none(), writeCalls };
        const notifyFiber = yield* transport
          .notify({
            id: incoming.value.id,
            frame: { _tag: "output", stream: "stdout", line: "x".repeat(8 * 1024 * 1024 + 1) },
          })
          .pipe(Effect.fork);
        yield* Effect.yieldNow();
        const poll = yield* Fiber.poll(notifyFiber);
        yield* Fiber.interrupt(notifyFiber);
        return { completion: poll, writeCalls };
      }).pipe(Effect.scoped),
    );

    // Then
    expect(outcome.writeCalls).toBe(0);
    expectPolledMcpTransportFailure(outcome.completion);
  });

  test("stdio-outstanding-request-cap-rejects-the-257th-as-busy", async () => {
    // Given
    const writes: string[] = [];
    const input = inputFromMessages(
      Array.from({ length: 257 }, (_, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: { name: "app:info" },
      })),
    );

    // When
    const receivedCount = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Effect.sync(() => writes.push(line)),
        });
        let count = 0;
        while (count < 256) {
          const incoming = yield* transport.receive;
          if (Option.isNone(incoming)) return count;
          count += 1;
        }
        return count;
      }).pipe(Effect.scoped),
    );

    // Then
    expect(receivedCount).toBe(256);
    expect(writes.map(parseJsonObject)).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 257,
        error: expect.objectContaining({ code: -32000 }),
      }),
    ]);
  });

  test("stdio-cancellation-cap-disconnects above 256", async () => {
    // Given
    const requestId = 18;
    const input = inputFromMessages([
      {
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name: "app:info" },
      },
      ...Array.from({ length: 257 }, () => ({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId },
      })),
    ]);

    // When
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({ catalog, input, write: () => Effect.void });
        const incoming = yield* transport.receive;
        if (Option.isNone(incoming)) return { count: 0, overflow: undefined };
        let count = 0;
        while (count < 256) {
          const cancellation = yield* transport.receiveCancel;
          if (Option.isNone(cancellation)) return { count, overflow: undefined };
          count += 1;
        }
        const overflow = yield* transport.receiveCancel.pipe(Effect.exit);
        return { count, overflow };
      }).pipe(Effect.scoped),
    );

    // Then
    expect(outcome.count).toBe(256);
    expect(outcome.overflow).toBeDefined();
    if (outcome.overflow !== undefined) expectMcpTransportFailure(outcome.overflow);
  });
});
