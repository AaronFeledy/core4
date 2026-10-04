import { expect, test } from "bun:test";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { Context, Effect, Layer } from "effect";
import { McpRuntimeConfig, McpService } from "../src/service.ts";
import { TestMcpCommandExecutor } from "./executor.ts";

test("MCP builds once per runtime, reuses it for nested provide, and builds freshly in a new run", async () => {
  // Given: the real MCP layer with the package's executor seam and an empty command catalog.
  const instances: Context.Service.Shape<typeof McpService>[] = [];
  const layer = McpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestMcpCommandExecutor,
        Layer.succeed(McpRuntimeConfig, {
          commandEntries: [],
          defaultAllowlist: [],
          runtimeLayer: Layer.empty,
        }),
        Layer.succeed(RedactionService, {
          registerValues: registerRedactionValues,
          forProfile: () => Effect.succeed(createRedactor("secrets")),
        }),
      ),
    ),
    Layer.tap((context) => Effect.sync(() => instances.push(Context.get(context, McpService)))),
  );
  const graph = Layer.merge(layer, layer);

  // When: reuse the graph, nesting a layer-based provide inside the first run.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* McpService;
      expect(yield* McpService).toBe(outer);
      expect(new Set(instances).size).toBe(1);
      const catalog = yield* outer.catalog();
      const nested = yield* McpService.pipe(Effect.provide(graph));
      expect(new Set(instances).size).toBe(1);
      expect(nested).toBe(outer);
      expect(yield* nested.catalog()).toBe(catalog);
      expect(yield* outer.catalog()).toBe(catalog);
      expect(yield* McpService).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(McpService.pipe(Effect.provide(graph)));

  // Then: each runtime gets its own service and catalog cache.
  expect(new Set(instances).size).toBe(2);
  expect(fresh).not.toBe(outer);
});
