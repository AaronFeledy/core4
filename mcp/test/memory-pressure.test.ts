import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { createRedactor } from "@lando/sdk/secrets";

import {
  type MemoryPressureLevel,
  attachMemoryPressureListener,
  handleMemoryPressure,
} from "@lando/mcp/memory-pressure";
import type { McpCommandEntry, McpCommandSpec } from "@lando/mcp/registry";
import { McpRuntimeConfig, type McpRuntimeConfigShape, McpService, McpServiceLive } from "@lando/mcp/service";
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
  test("clears the catalog cache and leaves in-flight work un-aborted", async () => {
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
});
