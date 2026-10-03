import { expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { McpService } from "@lando/mcp/service";
import { MAX_OUTBOUND_QUEUED_BYTES } from "@lando/mcp/stdio-limits";
import { makeStdioClient, startStdioClient } from "@lando/mcp/testing";
import { Deferred, Effect, Fiber, Layer, Schema, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { TestClock } from "effect/testing";
import { eventLayer, serverLayer, startServer, toolErrorObject } from "./server";
import type { LandoEvent } from "@lando/sdk/services";
import { expectMcpTransportFailure } from "./stdio-transport-test-support";

test("stdio-outbound-deadline-disconnects", async () => {
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const started = yield* Deferred.make<void>();
        let blocked = false;
        const stdio = Stdio.make({
          ...client.stdio,
          stdout: () =>
            forEachChunk((chunk: string | Uint8Array) =>
              blocked
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Stream.run(Stream.make(chunk), client.stdio.stdout()),
            ),
        });
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(Stdio.Stdio, stdio), Effect.forkScoped);
        yield* client.initialize();
        blocked = true;
        yield* client.sendRequest("tools/list");
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.await(fiber);
      }),
    ).pipe(Effect.provide(serverLayer()), Effect.provide(TestClock.layer())),
  );
  expect(expectMcpTransportFailure(exit)?.message).toBe(
    "MCP stdio stdout write exceeded the 5 second deadline.",
  );
});

test("stdio-never-reading-client-cannot-accumulate-unbounded-progress", async () => {
  let emitted = 0;
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const started = yield* Deferred.make<void>();
        let blocked = false;
        const spec = {
          id: "app:logs",
          summary: "Logs",
          resultSchema: Schema.Struct({}),
          run: () =>
            Effect.gen(function* () {
              const sink = yield* StreamFrameSink;
              for (let i = 0; i < 1025; i++) {
                emitted++;
                yield* sink.emit({ _tag: "stdout", chunk: `progress-${i}` });
              }
              return {};
            }),
        };
        const service = yield* McpService.pipe(
          Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] })),
        );
        const stdio = Stdio.make({
          ...client.stdio,
          stdout: () =>
            forEachChunk((chunk: string | Uint8Array) =>
              blocked
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Stream.run(Stream.make(chunk), client.stdio.stdout()),
            ),
        });
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(Stdio.Stdio, stdio), Effect.forkScoped);
        yield* client.initialize();
        blocked = true;
        yield* client.sendRequest("tools/call", {
          name: spec.id,
          _meta: { progressToken: "blocked-progress" },
        });
        yield* Deferred.await(started);
        yield* TestClock.adjust("4 seconds");
        const buffered = emitted;
        yield* TestClock.adjust("1 second");
        return { buffered, exit: yield* Fiber.await(fiber) };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  expect(observed.buffered).toBeGreaterThan(0);
  expect(observed.buffered).toBeLessThanOrEqual(11);
  expect(expectMcpTransportFailure(observed.exit)?.message).toBe(
    "MCP stdio stdout write exceeded the 5 second deadline.",
  );
});

test("stdio-outbound-byte-cap-rejects-progress-above-8-MiB-without-emitting-it", async () => {
  const spec = {
    id: "app:logs",
    summary: "Logs",
    resultSchema: Schema.Struct({}),
    run: () => Effect.succeed({}),
    streamFrames: () => [{ _tag: "stdout" as const, chunk: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1) }],
  };
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        const response = yield* client.request("tools/call", {
          name: spec.id,
          _meta: { progressToken: "oversized-progress" },
        });
        return { response, notifications: yield* client.notifications };
      }),
    ).pipe(Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }))),
  );
  expect(toolErrorObject(observed.response)).toMatchObject({
    _tag: "McpTransportError",
    message: expect.stringContaining("8 MiB"),
  });
  expect(observed.notifications).toEqual([]);
});

test("stdio-outstanding-request-cap-rejects-the-257th-as-busy-with-default-concurrency-4", async () => {
  let active = 0;
  let maximum = 0;
  const events: LandoEvent[] = [];
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const spec = {
          id: "app:info",
          summary: "Info",
          resultSchema: Schema.Struct({}),
          run: () =>
            Effect.sync(() => {
              active++;
              maximum = Math.max(maximum, active);
            }).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({}),
              Effect.ensuring(
                Effect.sync(() => {
                  active--;
                }),
              ),
            ),
        };
        const service = yield* McpService.pipe(
          Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }).pipe(Layer.provide(eventLayer(events)))),
        );
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
        const calls = [];
        for (let i = 0; i < 257; i++) calls.push(yield* client.sendRequest("tools/call", { name: spec.id }));
        const last = calls[256];
        if (last === undefined) throw new Error("Expected 257 requests");
        const busy = yield* last.response;
        const observedMaximum = maximum;
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.forEach(calls, (call) => call.response);
        return { busy, results, observedMaximum };
      }),
    ),
  );
  expect(observed.observedMaximum).toBe(4);
  expect(observed.results).toHaveLength(257);
  expect(events.filter((event) => event._tag === "pre-mcp-call")).toHaveLength(257);
  expect(events.filter((event) => event._tag === "post-mcp-call")).toHaveLength(257);
  expect(events.filter((event) => event._tag === "post-mcp-call" && event.outcome === "failure")).toEqual([expect.objectContaining({ failureDetail: "McpTransportError" })]);
  expect(toolErrorObject(observed.busy)).toEqual({
    _tag: "McpTransportError",
    message: "Server busy",
    remediation: "Restart the MCP client with healthy piped stdin/stdout and retry the request.",
  });
  expect(Schema.decodeUnknownSync(Schema.JsonObject)(observed.busy.result).structuredContent).toBeUndefined();
});

test("repeated cancellation notifications are consumed immediately without an accumulating cancellation queue", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        for (let i = 0; i < 257; i++) yield* client.cancel("not-running");
        const ping = yield* client.request("ping");
        yield* client.close;
        return { ping, exit: yield* Fiber.await(client.fiber) };
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  expect(observed.ping).toMatchObject({ result: {} });
  expect(observed.exit._tag).toBe("Success");
});
