import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Schema } from "effect";

import { createRedactor } from "@lando/sdk/secrets";

import {
  type MemoryPressureLevel,
  attachMemoryPressureListener,
  handleMemoryPressure,
} from "@lando/mcp/memory-pressure";
import type { McpCommandEntry, McpCommandSpec } from "@lando/mcp/registry";
import { McpRuntimeConfig, type McpRuntimeConfigShape, McpService, McpServiceLive } from "@lando/mcp/service";
import { McpTransport, makeInMemoryTransport } from "@lando/mcp/transport";
import { RedactionService } from "@lando/redaction/service";
import { TestMcpCommandExecutor } from "./executor";

const spec = (id: string, run: McpCommandSpec["run"] = () => Effect.void): McpCommandSpec => ({
  id,
  summary: `${id} summary`,
  resultSchema: Schema.Struct({}),
  run,
});

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

const serviceLayer = (config: McpRuntimeConfigShape) =>
  McpServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(McpRuntimeConfig, config), redactionLayer, TestMcpCommandExecutor),
    ),
  );

describe("handleMemoryPressure", () => {
  test("drops caches and closes idle sockets without aborting or exiting", () => {
    const dropped: string[] = [];
    handleMemoryPressure("critical", {
      dropCaches: () => {
        dropped.push("caches");
      },
      closeIdleSockets: () => {
        dropped.push("sockets");
      },
    });
    expect(dropped).toEqual(["caches", "sockets"]);
  });

  test('process.emit("memoryPressure") invokes the attached handler', () => {
    const levels: MemoryPressureLevel[] = [];
    const detach = attachMemoryPressureListener((level) => {
      levels.push(level);
    });
    try {
      expect(process.emit("memoryPressure", "warning")).toBe(true);
      expect(process.emit("memoryPressure", "critical")).toBe(true);
      expect(levels).toEqual(["warning", "critical"]);
    } finally {
      detach();
    }
  });
});

describe("McpService.handleMemoryPressure", () => {
  test("clears the catalog cache", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: spec("app:info") } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };

    const { first, second, third } = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpService;
        const first = yield* service.catalog();
        const second = yield* service.catalog();
        service.handleMemoryPressure("critical");
        const third = yield* service.catalog();
        return { first, second, third };
      }).pipe(Effect.provide(serviceLayer(config))),
    );

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(third.tools.map((tool) => tool.toolId)).toEqual(["app:info"]);
  });

  test("attaches during serve, leaves in-flight work un-aborted, and detaches on close", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        {
          spec: spec("app:exec", () =>
            Effect.promise(async () => {
              started.resolve();
              await finish.promise;
              return { finished: true };
            }),
          ),
        } satisfies McpCommandEntry,
      ],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const before = process.listenerCount("memoryPressure");
    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      const id = yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.promise(() => started.promise);
      const during = process.listenerCount("memoryPressure");
      expect(process.emit("memoryPressure", "warning")).toBe(true);
      finish.resolve();
      while ((yield* inmem.replies).length < 1) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { id, replies, during };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const { id, replies, during } = await Effect.runPromise(program);
    expect(during).toBe(before + 1);
    expect(process.listenerCount("memoryPressure")).toBe(before);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      id,
      ok: true,
      result: { ok: true, envelope: { ok: true, result: { finished: true } } },
    });
  });
});
