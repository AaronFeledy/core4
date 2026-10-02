import { expect, test } from "bun:test";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { Context, Effect, Layer } from "effect";
import { McpRuntimeConfig, McpService, McpServiceLive } from "../src/service.ts";
import { TestMcpCommandExecutor } from "./executor.ts";

test("MCP builds once per graph, twice with nested provide, and freshly in a new run", async () => {
  // Given: the real MCP layer with the package's executor seam and an empty command catalog.
  const instances: Context.Tag.Service<typeof McpService>[] = [];
  const layer = McpServiceLive.pipe(
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
      expect(instances).toHaveLength(1);
      const catalog = yield* outer.catalog();
      const nested = yield* McpService.pipe(Effect.provide(graph));
      expect(instances).toHaveLength(2);
      expect(nested).not.toBe(outer);
      expect(yield* nested.catalog()).not.toBe(catalog);
      expect(yield* outer.catalog()).toBe(catalog);
      expect(yield* McpService).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(McpService.pipe(Effect.provide(graph)));

  // Then: each memo-map boundary gets its own service and catalog cache.
  expect(instances).toHaveLength(3);
  expect(new Set(instances).size).toBe(3);
  expect(fresh).not.toBe(outer);
});
