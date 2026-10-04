import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { serverLayer, startServer } from "./server";

test("EOF closes after completed correlated requests without additional replies", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        const first = yield* client.request("tools/list");
        const second = yield* client.request("resources/list");
        yield* client.close;
        const exit = yield* Fiber.await(client.fiber);
        return { first, second, exit, messages: yield* client.messages };
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  expect(observed.first).toMatchObject({ result: { tools: [] } });
  expect(observed.second).toMatchObject({ result: { resources: [] } });
  expect(observed.exit._tag).toBe("Success");
  expect(observed.messages.filter((message) => message.id === observed.first.id)).toHaveLength(1);
  expect(observed.messages.filter((message) => message.id === observed.second.id)).toHaveLength(1);
});

test("EOF interrupts in-flight work and cancels semaphore-waiting work before serve returns", async () => {
  const executed: string[] = [];
  const finalized: string[] = [];
  let runtimeReleased = 0;
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const spec = {
          id: "app:exec",
          summary: "Block",
          resultSchema: Schema.Struct({}),
          run: () =>
            Effect.sync(() => {
              executed.push("app:exec");
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized.push("app:exec");
                }),
              ),
            ),
        };
        const service = yield* McpService.pipe(
          Effect.provide(
            serverLayer({
              commandEntries: [{ spec }],
              defaultAllowlist: [spec.id],
              runtimeLayer: Layer.effectDiscard(
                Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    runtimeReleased++;
                  }),
                ),
              ),
            }),
          ),
        );
        const client = yield* startStdioClient(service.serve({ transport: "stdio", maxConcurrent: 1 }));
        yield* client.sendRequest("tools/call", { name: spec.id }, "running");
        yield* Deferred.await(started);
        yield* client.sendRequest("tools/call", { name: spec.id }, "waiting");
        yield* client.request("ping");
        yield* client.close;
        const exit = yield* Fiber.await(client.fiber);
        return { exit, messages: yield* client.messages };
      }),
    ),
  );
  expect(observed.exit._tag).toBe("Success");
  expect(executed).toEqual(["app:exec"]);
  expect(finalized).toEqual(["app:exec"]);
  expect(runtimeReleased).toBe(1);
  expect(observed.messages.filter((message) => message.id === "running" || message.id === "waiting")).toEqual(
    [],
  );
});
