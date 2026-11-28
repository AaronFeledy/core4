import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { makeStdioClient } from "@lando/mcp/testing";
import { Deferred, Effect, Fiber, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { resultObject, serverLayer, startServer } from "./server";
import { expectMcpTransportFailure } from "./stdio-transport-test-support";

const encoder = new TextEncoder();
const malformed = '{"jsonrpc":"2.0","id":12,"method":"tools/list",}\n';
const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

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
          encoder.encode(
            `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: { padding: "x".repeat(1024 * 1024) } })}\n`,
          ),
        );
        const exit = yield* Fiber.await(fiber);
        return { exit, messages: yield* client.messages };
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  const error = expectMcpTransportFailure(result.exit);
  expect(error).toMatchObject({
    message: "MCP stdio frame exceeded the 1 MiB inbound limit.",
    remediation:
      "Reconnect and send each JSON-RPC message as one line of at most 1 MiB, including any CR before LF.",
  });
  expect(result.messages).toEqual([]);
});

test.each(['{"jsonrpc":"2.0","id":11,"method":"tools/list"}', "\f"])(
  "stdio-partial-frame-eof-disconnects on incomplete non-JSON-whitespace input %j",
  async (partial) => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeStdioClient();
          const service = yield* McpService;
          const fiber = yield* service
            .serve({ transport: "stdio" })
            .pipe(Effect.provide(client.layer), Effect.forkScoped);
          yield* client.raw(encoder.encode(partial));
          yield* client.close;
          return yield* Fiber.await(fiber);
        }),
      ).pipe(Effect.provide(serverLayer())),
    );
    expect(expectMcpTransportFailure(exit)).toMatchObject({
      message: "MCP stdio closed with an incomplete non-whitespace frame.",
      remediation: "End every JSON-RPC message with LF before closing stdin.",
    });
  },
);

test.each(["one write", "separate writes", "two malformed lines"] as const)(
  "stdio recovers around malformed JSON in %s",
  async (mode) => {
    const before = '{"jsonrpc":"2.0","id":19,"method":"ping"}\n';
    const after = '{"jsonrpc":"2.0","id":20,"method":"ping"}\n';
    const errors = mode === "two malformed lines" ? [parseError, parseError] : [parseError];
    const writes =
      mode === "separate writes"
        ? [before, malformed, after]
        : mode === "two malformed lines"
          ? [`${before}${malformed}\f\n${after}`]
          : [before + malformed + after];
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* startServer();
        yield* Effect.raceFirst(
          Effect.gen(function* () {
            for (const write of writes) yield* client.raw(encoder.encode(write));
            const pending = new Set([19, 20]);
            let receivedErrors = 0;
            while (pending.size > 0 || receivedErrors < errors.length) {
              const message = yield* client.next;
              if (message.id === null) receivedErrors++;
              if (typeof message.id === "number" && pending.delete(message.id)) {
                expect(message).toEqual({ jsonrpc: "2.0", id: message.id, result: {} });
              }
            }
            expect((yield* client.request("ping")).result).toEqual({});
          }),
          Fiber.join(client.fiber).pipe(Effect.andThen(Effect.never)),
        );
        yield* client.close;
        yield* Fiber.join(client.fiber);
        expect((yield* client.messages).filter((message) => message.id === null)).toEqual(errors);
      }).pipe(Effect.scoped, Effect.provide(serverLayer()), Effect.timeout("4 seconds")),
    );
  },
);

test.each([" \n", "\t\n", "\r\n", "  \t \r\n", "\n"])(
  "stdio ignores the blank line %j without a reply or error log",
  async (line) => {
    const errorLogs: unknown[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* startServer();
        yield* client.raw(encoder.encode(line));
        expect((yield* client.request("ping")).result).toEqual({});
        yield* client.close;
        yield* Fiber.join(client.fiber);
        expect((yield* client.messages).filter((message) => message.error !== undefined)).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provide(serverLayer()),
        Effect.provide(
          Logger.layer([
            Logger.make((event) => {
              if (event.logLevel === "Error") errorLogs.push(event.message);
            }),
          ]),
        ),
        Effect.timeout("4 seconds"),
      ),
    );
    expect(errorLogs).toEqual([]);
  },
);

test("stdio accepts a complete request with a CRLF ending", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* startServer();
      yield* client.raw(encoder.encode('{"jsonrpc":"2.0","id":30,"method":"ping"}\r\n'));
      let response = yield* client.next;
      while (response.id !== 30) response = yield* client.next;
      expect(response).toEqual({ jsonrpc: "2.0", id: 30, result: {} });
      yield* client.close;
      yield* Fiber.join(client.fiber);
      expect((yield* client.messages).filter((message) => message.error !== undefined)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(serverLayer()), Effect.timeout("4 seconds")),
  );
});

test("stdio keeps an in-flight tool running after a parse error", async () => {
  let finalized = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const spec = {
        id: "app:exec",
        summary: "Wait until released",
        resultSchema: Schema.Struct({}),
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({}),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
      };
      const client = yield* startServer().pipe(
        Effect.provide(
          serverLayer({
            commandEntries: [{ kind: "command", spec }],
            defaultAllowlist: [spec.id],
          }),
        ),
      );
      const call = yield* client.sendRequest("tools/call", { name: spec.id }, "running");
      yield* Deferred.await(started);
      yield* Effect.raceFirst(
        Effect.gen(function* () {
          yield* client.raw(encoder.encode(malformed));
          let message = yield* client.next;
          while (message.id !== null) message = yield* client.next;
          expect(message).toEqual(parseError);
          yield* Deferred.succeed(release, undefined);
          expect(resultObject(yield* call.response).structuredContent).toMatchObject({ ok: true });
        }),
        Fiber.join(client.fiber).pipe(Effect.andThen(Effect.never)),
      );
      yield* client.close;
      yield* Fiber.join(client.fiber);
    }).pipe(Effect.scoped, Effect.timeout("4 seconds")),
  );
  expect(finalized).toBe(1);
});

test.each([
  { partial: '{"jsonrpc":"2.0"', drip: false },
  { partial: '{"jsonrpc":"2.0"', drip: true },
  { partial: " ", drip: false },
])(
  "partial-frame deadline remains 5 seconds for $partial with slow-loris=$drip",
  async ({ partial, drip }) => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeStdioClient();
          const service = yield* McpService;
          const fiber = yield* service
            .serve({ transport: "stdio" })
            .pipe(Effect.provide(client.layer), Effect.forkScoped);
          yield* client.raw(encoder.encode(partial));
          yield* Effect.yieldNow;
          yield* TestClock.adjust("0 millis");
          yield* TestClock.adjust("4 seconds");
          if (drip) yield* client.raw(encoder.encode(',"id":15'));
          yield* TestClock.adjust("1 second");
          return yield* Fiber.await(fiber);
        }),
      ).pipe(Effect.provide(serverLayer()), Effect.provide(TestClock.layer())),
    );
    expect(expectMcpTransportFailure(exit)).toMatchObject({
      message: "MCP stdio partial frame exceeded the 5 second deadline.",
      remediation:
        "Reconnect and write each JSON-RPC message with its terminating LF in one flush, within 5 seconds of its first byte.",
    });
  },
);

test("stdio closes cleanly after complete and trailing partial blank frames", async () => {
  const observed = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* startServer();
      yield* client.raw(encoder.encode("  \n\t"));
      yield* client.close;
      return { exit: yield* Fiber.await(client.fiber), messages: yield* client.messages };
    }).pipe(Effect.scoped, Effect.provide(serverLayer())),
  );
  expect(observed.exit._tag).toBe("Success");
  expect(observed.messages.filter((message) => message.error !== undefined)).toEqual([]);
});
