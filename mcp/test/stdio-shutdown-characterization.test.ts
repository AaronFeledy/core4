import { describe, expect, test } from "bun:test";
import { McpRuntimeConfig, McpService, McpServiceLive } from "@lando/mcp/service";
import { makeStdioMcpTransport } from "@lando/mcp/stdio-transport";
import { McpTransport } from "@lando/mcp/transport";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestMcpCommandExecutor } from "./executor";

const encoder = new TextEncoder();
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app:exec" } });

describe("stdio transport shutdown", () => {
  test("EOF drains queued requests before receive reports completion", async () => {
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(
          encoder.encode(`${[call(1), call(2)].map((message) => JSON.stringify(message)).join("\n")}\n`),
        );
        controller.close();
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog: { tools: [] },
          input,
          write: () => Effect.void,
        });
        // Waiting for the cancellation channel to end ensures the reader reached EOF before requests are consumed.
        const cancellations = yield* transport.receiveCancel;
        const first = yield* transport.receive;
        const second = yield* transport.receive;
        const end = yield* transport.receive;
        return { cancellations, first, second, end };
      }).pipe(Effect.scoped),
    );

    expect(result).toEqual({
      cancellations: Option.none(),
      first: Option.some({ id: "req-1", request: { toolId: "app:exec" } }),
      second: Option.some({ id: "req-2", request: { toolId: "app:exec" } }),
      end: Option.none(),
    });
  });

  test("EOF interrupts in-flight work and cancels semaphore-waiting work before serve returns", async () => {
    const executed: string[] = [];
    const finalized: string[] = [];
    const writes: string[] = [];
    let runtimeReleased = 0;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const queued = yield* Deferred.make<void>();
        const eof = Promise.withResolvers<void>();
        const input = new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(`${[call(1), call(2)].map((message) => JSON.stringify(message)).join("\n")}\n`),
            );
          },
          pull: async (controller) => {
            await eof.promise;
            controller.close();
          },
        });
        const transport = yield* makeStdioMcpTransport({
          catalog: { tools: [] },
          input,
          write: (line) =>
            Effect.sync(() => {
              writes.push(line);
            }),
        });
        const config = Layer.succeed(McpRuntimeConfig, {
          commandEntries: [
            {
              spec: {
                id: "app:exec",
                summary: "Block until transport closes",
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
              },
            },
          ],
          defaultAllowlist: ["app:exec"],
          runtimeLayer: Layer.effectDiscard(
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                runtimeReleased += 1;
              }),
            ),
          ),
        });
        const layer = McpServiceLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              config,
              TestMcpCommandExecutor,
              Layer.succeed(RedactionService, {
                registerValues: registerRedactionValues,
                forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
              }),
            ),
          ),
        );
        const observedTransport = {
          ...transport,
          receive: transport.receive.pipe(
            Effect.tap((incoming) =>
              Option.isSome(incoming) && incoming.value.id === "req-2"
                ? Deferred.succeed(queued, undefined)
                : Effect.void,
            ),
          ),
        };
        const fiber = yield* Effect.flatMap(McpService, (service) =>
          service.serve({ transport: "stdio", maxConcurrent: 1 }),
        ).pipe(
          Effect.provide(layer),
          Effect.provideService(McpTransport, observedTransport),
          Effect.forkScoped,
        );
        yield* Deferred.await(started);
        yield* Deferred.await(queued);
        yield* Effect.sync(() => eof.resolve());
        return yield* Fiber.await(fiber);
      }).pipe(Effect.scoped),
    );

    expect(result._tag).toBe("Success");
    expect(executed).toEqual(["app:exec"]);
    expect(finalized).toEqual(["app:exec"]);
    expect(runtimeReleased).toBe(1);
    expect(writes).toEqual([]);
  });
});
