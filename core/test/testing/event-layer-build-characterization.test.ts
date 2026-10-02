import { expect, test } from "bun:test";
import { EventServiceLive, recordedEvents } from "@lando/core/testing";
import { EventService } from "@lando/sdk/services";
import { Context, DateTime, Effect, Layer } from "effect";

test("the public testing event bus shares a graph but rebuilds for nested provide and a new run", async () => {
  // Given: use the public testing export, not makeTestRuntime's fake event bus.
  const instances: Context.Service.Shape<typeof EventService>[] = [];
  const layer = EventServiceLive.pipe(
    Layer.tap((context) => Effect.sync(() => instances.push(Context.get(context, EventService)))),
  );
  const graph = Layer.merge(layer, layer);

  // When: write outer history and read the histories across memo-map boundaries.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* EventService;
      yield* outer.publish({ _tag: "ready", timestamp: DateTime.makeUnsafe(0) });
      expect(instances).toHaveLength(1);
      expect(yield* recordedEvents()).toHaveLength(1);
      const nested = yield* Effect.gen(function* () {
        expect(yield* recordedEvents()).toEqual([]);
        return yield* EventService;
      }).pipe(Effect.provide(graph));
      expect(instances).toHaveLength(2);
      expect(nested).not.toBe(outer);
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

  // Then: three real buses were constructed, with independent history buffers.
  expect(instances).toHaveLength(3);
  expect(new Set(instances).size).toBe(3);
  expect(fresh).not.toBe(outer);
});
