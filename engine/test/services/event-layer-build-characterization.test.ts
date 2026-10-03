import { expect, test } from "bun:test";
import { EventService } from "@lando/sdk/services";
import { Context, Effect, Layer } from "effect";
import * as LandoEventService from "../../src/services/event-service.ts";

test("EventService builds once per runtime, reuses it for nested provide, and rebuilds for a new run", async () => {
  // Given: observe successful builds of the real layer and its fresh service instances.
  const instances: Context.Service.Shape<typeof EventService>[] = [];
  const layer = LandoEventService.layer.pipe(
    Layer.tap((context) => Effect.sync(() => instances.push(Context.get(context, EventService)))),
  );
  const graph = Layer.merge(layer, layer);

  // When: reuse one layer value within a graph, then provide it again inside that run.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* EventService;
      expect(yield* EventService).toBe(outer);
      expect(new Set(instances).size).toBe(1);
      const nested = yield* EventService.pipe(Effect.provide(graph));
      expect(new Set(instances).size).toBe(1);
      expect(nested).toBe(outer);
      expect(yield* EventService).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(EventService.pipe(Effect.provide(graph)));

  // Then: Effect 4 forks the parent memo map for nested provides; each top-level run starts a fresh one.
  expect(new Set(instances).size).toBe(2);
  expect(fresh).not.toBe(outer);
});
