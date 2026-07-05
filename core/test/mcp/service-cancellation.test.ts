import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";

import { createRedactor } from "@lando/sdk/secrets";

import { EmptyResultSchema, type LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { McpTransport } from "../../src/mcp/transport.ts";
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
    const requestId = "cancel-in-flight";
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
      let requestDelivered = false;
      let cancelDelivered = false;
      const service = yield* McpService;
      const transport = {
        receive: Effect.sync(() => {
          if (requestDelivered) return Option.none();
          requestDelivered = true;
          return Option.some({ id: requestId, request: { toolId: "app:exec" } });
        }),
        receiveCancel: Effect.gen(function* () {
          if (cancelDelivered) return Option.none();
          cancelDelivered = true;
          yield* Effect.sleep("10 millis");
          return Option.some(requestId);
        }),
        reply: () => Effect.void,
        notify: () => Effect.void,
      };

      yield* service.serve({ transport: "stdio" }).pipe(Effect.provideService(McpTransport, transport));
    }).pipe(Effect.provide(serviceLayer(config)));

    await Effect.runPromise(program);
    expect(finalized).toBe(true);
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
      const service = yield* McpService;
      const transport = {
        receive: Effect.gen(function* () {
          if (requestDelivered) return Option.none();
          requestDelivered = true;
          yield* Effect.sleep("10 millis");
          return Option.some({ id: requestId, request: { toolId: "app:exec" } });
        }),
        receiveCancel: Effect.sync(() => {
          if (cancelDelivered) return Option.none();
          cancelDelivered = true;
          return Option.some(requestId);
        }),
        reply: () => Effect.void,
        notify: () => Effect.void,
      };

      yield* service.serve({ transport: "stdio" }).pipe(Effect.provideService(McpTransport, transport));
    }).pipe(Effect.provide(serviceLayer(config)));

    await Effect.runPromise(program);
    expect(executed).toBe(false);
  });
});
