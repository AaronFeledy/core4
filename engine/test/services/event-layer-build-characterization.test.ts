import { expect, test } from "bun:test";
import { EventService } from "@lando/sdk/services";
import { Context, Effect, Layer } from "effect";
import { EventServiceLive } from "../../src/services/event-service.ts";

test("EventService builds once per graph, rebuilds for nested provide, and rebuilds for a new run", async () => {
  // Given: observe successful builds of the real layer and its fresh service instances.
  const instances: Context.Tag.Service<typeof EventService>[] = [];
  const layer = EventServiceLive.pipe(
    Layer.tap((context) => Effect.sync(() => instances.push(Context.get(context, EventService)))),
  );
  const graph = Layer.merge(layer, layer);

  // When: reuse one layer value within a graph, then provide it again inside that run.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* EventService;
      expect(yield* EventService).toBe(outer);
      expect(instances).toHaveLength(1);
      const nested = yield* EventService.pipe(Effect.provide(graph));
      expect(instances).toHaveLength(2);
      expect(nested).not.toBe(outer);
      expect(yield* EventService).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(EventService.pipe(Effect.provide(graph)));

  // Then: Effect 3 uses fresh memo maps for nested layer provides and top-level runs.
  expect(instances).toHaveLength(3);
  expect(new Set(instances).size).toBe(3);
  expect(fresh).not.toBe(outer);
});
