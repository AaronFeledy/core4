import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import type { LandoEvent } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { eventLayer, serverLayer, startServer } from "./server";

test("interrupts an in-flight call, publishes Interrupted, and emits no duplicate cancellation response", async () => {
  const events: LandoEvent[] = [];
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const command = {
          id: "app:exec",
          summary: "Block",
          resultSchema: Schema.Struct({}),
          run: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finished, undefined)),
            ),
        };
        const service = yield* McpService.pipe(
          Effect.provide(
            serverLayer({ commandEntries: [{ spec: command }], defaultAllowlist: [command.id] }).pipe(
              Layer.provide(eventLayer(events)),
            ),
          ),
        );
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
        const call = yield* client.sendRequest("tools/call", { name: command.id });
        yield* Deferred.await(started);
        yield* client.cancel(call.id);
        yield* Deferred.await(finished);
        yield* client.cancel(call.id);
        yield* client.request("ping");
        yield* client.close;
        yield* Fiber.join(client.fiber);
        return { id: call.id, messages: yield* client.messages };
      }),
    ),
  );
  expect(observed.messages.filter((message) => message.id === observed.id)).toEqual([]);
  expect(events.filter((event) => event._tag === "pre-mcp-call")).toHaveLength(1);
  expect(events.filter((event) => event._tag === "post-mcp-call")).toEqual([
    expect.objectContaining({ outcome: "failure", failureDetail: "Interrupted" }),
  ]);
});

test("does not send a cancellation reply after a completed request is cancelled", async () => {
  const messages = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        const result = yield* client.request("tools/call", { name: "app:info" });
        if (typeof result.id !== "number") throw new Error("Expected numeric response id");
        yield* client.cancel(result.id);
        yield* client.request("ping");
        return (yield* client.messages).filter((message) => message.id === result.id);
      }),
    ).pipe(
      Effect.provide(
        serverLayer({
          commandEntries: [
            {
              spec: {
                id: "app:info",
                summary: "Info",
                resultSchema: Schema.Struct({ finished: Schema.Boolean }),
                run: () => Effect.succeed({ finished: true }),
              },
            },
          ],
          defaultAllowlist: ["app:info"],
        }),
      ),
    ),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    result: { isError: false, structuredContent: { ok: true, result: { finished: true } } },
  });
});

test("does not poison a reused request id when a late cancellation arrives", async () => {
  let executions = 0;
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        const first = yield* (yield* client.sendRequest("tools/call", { name: "app:info" }, "reused-id"))
          .response;
        yield* client.cancel("reused-id");
        yield* client.request("ping");
        const second = yield* (yield* client.sendRequest("tools/call", { name: "app:info" }, "reused-id"))
          .response;
        return [first, second];
      }),
    ).pipe(
      Effect.provide(
        serverLayer({
          commandEntries: [
            {
              spec: {
                id: "app:info",
                summary: "Info",
                resultSchema: Schema.Struct({ executions: Schema.Number }),
                run: () => Effect.sync(() => ({ executions: ++executions })),
              },
            },
          ],
          defaultAllowlist: ["app:info"],
        }),
      ),
    ),
  );
  expect(executions).toBe(2);
  expect(results).toHaveLength(2);
  expect(results).toEqual([
    expect.objectContaining({ result: expect.objectContaining({ isError: false }) }),
    expect.objectContaining({ result: expect.objectContaining({ isError: false }) }),
  ]);
});

test("does not start semaphore-waiting work when cancellation arrives before execution", async () => {
  let executions = 0;
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const command = {
          id: "app:exec",
          summary: "Block",
          resultSchema: Schema.Struct({}),
          run: () =>
            Effect.sync(() => {
              executions++;
            }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
        };
        const service = yield* McpService.pipe(
          Effect.provide(
            serverLayer({ commandEntries: [{ spec: command }], defaultAllowlist: [command.id] }),
          ),
        );
        const client = yield* startStdioClient(service.serve({ transport: "stdio", maxConcurrent: 1 }));
        yield* client.sendRequest("tools/call", { name: command.id }, "running");
        yield* Deferred.await(started);
        yield* client.sendRequest("tools/call", { name: command.id }, "waiting");
        yield* client.cancel("waiting");
        yield* client.request("ping");
        yield* client.close;
        yield* Fiber.join(client.fiber);
        return yield* client.messages;
      }),
    ),
  );
  expect(executions).toBe(1);
  expect(observed.filter((message) => message.id === "waiting")).toEqual([]);
});
