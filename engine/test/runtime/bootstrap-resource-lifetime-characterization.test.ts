import { expect, test } from "bun:test";
import { EventService } from "@lando/sdk/services";
import { Context, Effect, Exit, Layer, Runtime, Scope } from "effect";
import {
  makeBootstrapLifecycleTracker,
  superviseBootstrapLayer,
} from "../../src/runtime/bootstrap-lifecycle.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

class Resource extends Context.Tag("bootstrap-resource-lifetime-test/Resource")<
  Resource,
  { readonly isOpen: Effect.Effect<boolean> }
>() {}

test("bootstrap resources outlive runtime construction and runs, and close with the runtime scope", async () => {
  // Given: the real bootstrap supervisor owns a scoped resource and a real event bus.
  const tracker = makeBootstrapLifecycleTracker();
  let acquired = 0;
  let released = 0;
  const closeOrder: string[] = [];
  const events = EventServiceLive.pipe(
    Layer.tap((context) => tracker.complete("minimal", Context.get(context, EventService))),
  );
  const resource = Layer.scoped(
    Resource,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired += 1;
        return { isOpen: Effect.sync(() => released === 0) };
      }),
      () =>
        Effect.gen(function* () {
          const events = tracker.eventService();
          if (events !== undefined) {
            closeOrder.push(
              ...(yield* events.query("*"))
                .filter((event) => event._tag === "before-exit")
                .map((event) => event._tag),
            );
          }
          released += 1;
          closeOrder.push("release");
        }),
    ),
  );
  const layer = superviseBootstrapLayer(Layer.merge(events, resource), tracker);
  const runtimeScope = await Effect.runPromise(Scope.make());

  // When: building returns a retained runtime, then two independent runtime runs finish.
  try {
    const runtime = await Effect.runPromise(Layer.toRuntime(layer).pipe(Scope.extend(runtimeScope)));
    expect(acquired).toBe(1);
    expect(released).toBe(0);
    const use = Resource.pipe(Effect.flatMap((resource) => resource.isOpen));
    expect(await Runtime.runPromise(runtime)(use)).toBe(true);
    expect(released).toBe(0);
    expect(await Runtime.runPromise(runtime)(use)).toBe(true);
    expect(released).toBe(0);
  } finally {
    await Effect.runPromise(Scope.close(runtimeScope, Exit.void));
  }

  // Then: only runtime scope closure releases the resource, after before-exit publication.
  expect(acquired).toBe(1);
  expect(released).toBe(1);
  expect(closeOrder).toEqual(["before-exit", "release"]);
});
