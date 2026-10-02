import { expect, test } from "bun:test";
import { Telemetry } from "@lando/sdk/services";
import { Context, Effect, Layer } from "effect";
import { makeTelemetryLayer } from "../src/service.ts";

test("enabled telemetry builds once per runtime, reuses it for nested provide, and builds freshly in a new run", async () => {
  // Given: enabled telemetry constructs a real scoped queue and dispatcher, with no external sinks.
  const instances: Context.Service.Shape<typeof Telemetry>[] = [];
  const layer = makeTelemetryLayer(true).pipe(
    Layer.tap((context) => Effect.sync(() => instances.push(Context.get(context, Telemetry)))),
  );
  const graph = Layer.merge(layer, layer);

  // When: provide the same graph both outside and inside a single run, then in another run.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* Telemetry;
      expect(outer.enabled).toBe(true);
      expect(yield* Telemetry).toBe(outer);
      expect(new Set(instances).size).toBe(1);
      const nested = yield* Telemetry.pipe(Effect.provide(graph));
      expect(new Set(instances).size).toBe(1);
      expect(nested).toBe(outer);
      expect(yield* Telemetry).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(Telemetry.pipe(Effect.provide(graph)));

  // Then: one transport per run.
  expect(new Set(instances).size).toBe(2);
  expect(fresh).not.toBe(outer);
});
