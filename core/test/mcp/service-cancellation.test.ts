import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";

import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { McpTransport, type McpTransportReply, makeInMemoryTransport } from "../../src/mcp/transport.ts";
import { RedactionService } from "../../src/redaction/service.ts";

const spec = (id: string, run: LandoCommandSpec["run"]): LandoCommandSpec => ({
  id,
  summary: `${id} summary`,
  namespace: id.split(":")[0] as LandoCommandSpec["namespace"],
  bootstrap: "app",
  resultSchema: EmptyResultSchema,
  run,
});

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: [] })),
});

const serviceLayer = (config: McpRuntimeConfigShape) =>
  McpServiceLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(McpRuntimeConfig, config), redactionLayer)));

describe("McpService.serve cancellation", () => {
  test("interrupts a single in-flight call when the transport cancels its request id", async () => {
    let finalized = false;
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        {
          spec: spec("app:exec", () =>
            Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true;
                }),
              ),
            ),
          ),
        } satisfies McpCommandEntry,
      ],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      const id = yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("10 millis");
      yield* inmem.cancel(id);
      while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { id, replies };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const { id, replies } = await Effect.runPromise(program);
    expect(finalized).toBe(true);
    expect(replies).toEqual([
      { id, ok: false, error: expect.objectContaining({ _tag: "McpTransportError" }) },
    ]);
  });

  test("sends one reply when cancelling an in-flight call", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        {
          spec: spec("app:exec", () => Effect.never),
        } satisfies McpCommandEntry,
      ],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      const id = yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("10 millis");
      yield* inmem.cancel(id);
      yield* Effect.sleep("80 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { id, replies };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const { id, replies } = await Effect.runPromise(program);
    expect(replies).toEqual([
      { id, ok: false, error: expect.objectContaining({ _tag: "McpTransportError" }) },
    ]);
  });

  test("does not send a cancellation reply after a completed request is cancelled", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        {
          spec: spec("app:info", () => Effect.succeed({ finished: true })),
        } satisfies McpCommandEntry,
      ],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      const id = yield* inmem.push({ toolId: "app:info" });
      while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
      yield* inmem.cancel(id);
      yield* Effect.sleep("80 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { id, replies };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const { id, replies } = await Effect.runPromise(program);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id,
      ok: true,
      result: { ok: true, envelope: { ok: true, result: { finished: true } } },
    });
  });

  test("does not start a request when cancellation arrives before request registration", async () => {
    let executed = false;
    const requestId = "cancel-before-start";
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        {
          spec: spec("app:exec", () =>
            Effect.sync(() => {
              executed = true;
              return {};
            }),
          ),
        } satisfies McpCommandEntry,
      ],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      let requestDelivered = false;
      let cancelDelivered = false;
      const replies: McpTransportReply[] = [];
      const replied = yield* Deferred.make<void>();
      const service = yield* McpService;
      const transport = {
        receive: Effect.gen(function* () {
          if (requestDelivered) return yield* Deferred.await(replied).pipe(Effect.as(Option.none()));
          yield* Effect.sleep("10 millis");
          requestDelivered = true;
          return Option.some({ id: requestId, request: { toolId: "app:exec" } });
        }),
        receiveCancel: Effect.gen(function* () {
          if (cancelDelivered) return yield* Deferred.await(replied).pipe(Effect.as(Option.none<string>()));
          cancelDelivered = true;
          return Option.some(requestId);
        }),
        reply: (reply: McpTransportReply) =>
          Effect.sync(() => replies.push(reply)).pipe(Effect.zipRight(Deferred.succeed(replied, undefined))),
        notify: () => Effect.void,
      };

      yield* service.serve({ transport: "stdio" }).pipe(Effect.provideService(McpTransport, transport));
      return replies;
    }).pipe(Effect.provide(serviceLayer(config)));

    const replies = await Effect.runPromise(program);
    expect(executed).toBe(false);
    expect(replies).toEqual([
      { id: requestId, ok: false, error: expect.objectContaining({ _tag: "McpTransportError" }) },
    ]);
  });
});
