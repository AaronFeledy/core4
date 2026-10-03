import { expect, test } from "bun:test";
import { recordedEvents } from "@lando/core/testing";
import * as LandoEventService from "@lando/engine/services/event-service";
import { EventService } from "@lando/sdk/services";
import { Context, DateTime, Effect, Layer } from "effect";

test("the public testing event bus is shared within a run, including nested provide, and rebuilt for a new run", async () => {
  // Given: use the public testing export, not makeTestRuntime's fake event bus.
  const instances: Context.Service.Shape<typeof EventService>[] = [];
  const layer = LandoEventService.layer.pipe(
    Layer.tap((context) => Effect.sync(() => instances.push(Context.get(context, EventService)))),
  );
  const graph = Layer.merge(layer, layer);

  // When: write outer history and read the histories across memo-map boundaries.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* EventService;
      yield* outer.publish({ _tag: "ready", timestamp: DateTime.makeUnsafe(0) });
      expect(new Set(instances).size).toBe(1);
      expect(yield* recordedEvents()).toHaveLength(1);
      const nested = yield* Effect.gen(function* () {
        expect(yield* recordedEvents()).toHaveLength(1);
        return yield* EventService;
      }).pipe(Effect.provide(graph));
      expect(new Set(instances).size).toBe(1);
      expect(nested).toBe(outer);
      expect(yield* EventService).toBe(outer);
      expect(yield* recordedEvents()).toHaveLength(1);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* recordedEvents()).toEqual([]);
      return yield* EventService;
    }).pipe(Effect.provide(graph)),
  );

  // Then: two real buses were constructed, one per run, with independent history buffers.
  expect(new Set(instances).size).toBe(2);
  expect(fresh).not.toBe(outer);
});
