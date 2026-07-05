import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer } from "effect";

import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { McpTransport, makeInMemoryTransport } from "../../src/mcp/transport.ts";
import { RedactionService } from "../../src/redaction/service.ts";

const spec = (
  id: string,
  run: LandoCommandSpec["run"],
  extra: Partial<LandoCommandSpec> = {},
): LandoCommandSpec => ({
  id,
  summary: `${id} summary`,
  namespace: id.split(":")[0] as LandoCommandSpec["namespace"],
  bootstrap: "app",
  resultSchema: EmptyResultSchema,
  run,
  ...extra,
});

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: [] })),
});

const configLayer = (config: McpRuntimeConfigShape) => Layer.succeed(McpRuntimeConfig, config);

const serviceLayer = (config: McpRuntimeConfigShape) =>
  McpServiceLive.pipe(Layer.provide(Layer.mergeAll(configLayer(config), redactionLayer)));

describe("McpService.catalog", () => {
  test("lists the effective allowlist as tools", async () => {
    const config: McpRuntimeConfigShape = {
      commandEntries: [
        { spec: spec("app:info", () => Effect.succeed({})) },
        { spec: spec("app:destroy", () => Effect.succeed({})) },
      ],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };
    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* McpService;
        return yield* service.catalog();
      }).pipe(Effect.provide(serviceLayer(config))),
    );
    expect(catalog.tools.map((tool) => tool.toolId)).toEqual(["app:info"]);
  });
});

describe("McpService.serve", () => {
  test("caps concurrency at mcp.maxConcurrent", async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = spec("app:exec", () =>
      Effect.gen(function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield* Effect.promise(() => gate);
        active -= 1;
        return {};
      }),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: blocking } satisfies McpCommandEntry],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio", maxConcurrent: 2 })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      for (let index = 0; index < 5; index += 1) yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("80 millis");
      const observedMax = maxActive;
      const observedActive = active;
      release();
      while ((yield* inmem.replies).length < 5) yield* Effect.sleep("10 millis");
      const replies = yield* inmem.replies;
      yield* inmem.close;
      yield* Fiber.join(fiber);
      return { observedMax, observedActive, replies: replies.length };
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    const outcome = await Effect.runPromise(program);
    expect(outcome.observedMax).toBe(2);
    expect(outcome.observedActive).toBe(2);
    expect(outcome.replies).toBe(5);
  });

  test("interrupts and finalizes in-flight calls when the transport closes", async () => {
    let finalized = false;
    const hanging = spec("app:exec", () =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    );
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: hanging } satisfies McpCommandEntry],
      defaultAllowlist: ["app:exec"],
      runtimeLayer: Layer.empty,
    };

    const program = Effect.gen(function* () {
      const inmem = yield* makeInMemoryTransport();
      const service = yield* McpService;
      const fiber = yield* service
        .serve({ transport: "stdio" })
        .pipe(Effect.provideService(McpTransport, inmem.transport), Effect.forkScoped);
      yield* inmem.push({ toolId: "app:exec" });
      yield* Effect.sleep("50 millis");
      yield* inmem.close;
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer(config)));

    await Effect.runPromise(program);
    expect(finalized).toBe(true);
  });
});
