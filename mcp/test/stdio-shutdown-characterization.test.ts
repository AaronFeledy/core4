import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { serverLayer, startServer } from "./server";

test("EOF closes after completed correlated requests without additional replies", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given completed requests and their full output before EOF.
        const client = yield* startServer();
        const first = yield* client.request("tools/list");
        const second = yield* client.request("resources/list");
        const beforeClose = yield* client.messages;
        // When EOF closes the session.
        yield* client.close;
        const exit = yield* Fiber.await(client.fiber);
        return { first, second, exit, beforeClose, messages: yield* client.messages };
      }),
    ).pipe(Effect.provide(serverLayer())),
  );
  // Then completed replies remain intact and shutdown adds no output.
  expect(observed.first).toMatchObject({ result: { tools: [] } });
  expect(observed.second).toMatchObject({ result: { resources: [] } });
  expect(observed.exit._tag).toBe("Success");
  expect(observed.messages).toEqual(observed.beforeClose);
  expect(observed.messages.filter((message) => message.id === observed.first.id)).toHaveLength(1);
  expect(observed.messages.filter((message) => message.id === observed.second.id)).toHaveLength(1);
});

for (const shutdown of ["EOF", "interrupt"] as const) {
  test(`${shutdown} interrupts in-flight work and cancels semaphore-waiting work before serve returns`, async () => {
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
                  Effect.yieldNow.pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        finalized.push("app:exec");
                      }),
                    ),
                  ),
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
          if (shutdown === "EOF") yield* client.close;
          else yield* Fiber.interrupt(client.fiber);
          const exit = yield* Fiber.await(client.fiber);
          return { exit, messages: yield* client.messages };
        }),
      ),
    );
    expect(observed.exit._tag).toBe(shutdown === "EOF" ? "Success" : "Failure");
    expect(executed).toEqual(["app:exec"]);
    expect(finalized).toEqual(["app:exec"]);
    expect(runtimeReleased).toBe(1);
    expect(
      observed.messages.filter((message) => message.id === "running" || message.id === "waiting"),
    ).toEqual([]);
  });
}
