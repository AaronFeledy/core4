import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { makeStdioClient } from "@lando/mcp/testing";
import { Effect, Fiber, Stdio } from "effect";
import { TestClock } from "effect/testing";
import { serverLayer } from "./server";
import { expectMcpTransportFailure } from "./stdio-transport-test-support";

test("stdio-oversized-frame-disconnects before parsing a frame over 1 MiB", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provide(client.layer), Effect.forkScoped);
        yield* client.raw(
          new TextEncoder().encode(
            `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: { padding: "x".repeat(1024 * 1024) } })}\n`,
          ),
        );
        const exit = yield* Fiber.await(fiber);
        return { exit, messages: yield* client.messages };
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  const error = expectMcpTransportFailure(result.exit);
  expect(error?.message).toBe("MCP stdio frame exceeded the 1 MiB inbound limit.");
  expect(result.messages).toEqual([]);
});

test("stdio-partial-frame-eof-disconnects without parsing the trailing buffer", async () => {
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provide(client.layer), Effect.forkScoped);
        yield* client.raw(new TextEncoder().encode('{"jsonrpc":"2.0","id":11,"method":"tools/list"}'));
        yield* client.close;
        return yield* Fiber.await(fiber);
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  expect(expectMcpTransportFailure(exit)?.message).toBe(
    "MCP stdio closed with an incomplete non-whitespace frame.",
  );
});

test("stdio-malformed-frame-single-parse-error", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provide(client.layer), Effect.forkScoped);
        yield* client.raw(new TextEncoder().encode('{"jsonrpc":"2.0","id":12,"method":"tools/list",}\n'));
        const exit = yield* Fiber.await(fiber);
        return { exit, messages: yield* client.messages };
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  expectMcpTransportFailure(observed.exit);
  expect(observed.messages).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error", _tag: "ParseError" } },
  ]);
});

test.each([false, true])("partial-frame deadline remains 5 seconds with slow-loris=%s", async (drip) => {
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provide(client.layer), Effect.forkScoped);
        yield* client.raw(new TextEncoder().encode('{"jsonrpc":"2.0"'));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("0 millis");
        yield* TestClock.adjust("4 seconds");
        if (drip) yield* client.raw(new TextEncoder().encode(',"id":15'));
        yield* TestClock.adjust("1 second");
        return yield* Fiber.await(fiber);
      }),
    ).pipe(Effect.provide(serverLayer()), Effect.provide(TestClock.layer())),
  );
  expect(expectMcpTransportFailure(exit)?.message).toBe(
    "MCP stdio partial frame exceeded the 5 second deadline.",
  );
});

test("accepts fragmented and multiple complete frames without leaking partial EOF bytes", async () => {
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(Stdio.Stdio, client.stdio), Effect.forkScoped);
        yield* client.initialize();
        yield* client.raw(new TextEncoder().encode("  \n\t"));
        yield* client.close;
        return yield* Fiber.await(fiber);
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  expect(exit._tag).toBe("Success");
});
