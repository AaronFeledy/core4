import { expect, test } from "bun:test";
import { Effect } from "effect";
import { fixture, runScanner, scratchId } from "./scanner-fixture.ts";

test("prepared scratch teardown stops containers before removing volumes", async () => {
  // Given labeled provider resources.
  const f = fixture();
  // When the prepared phases are executed in lifecycle order.
  await runScanner([f.provider], (scanner) =>
    Effect.gen(function* () {
      const prepared = yield* scanner.prepareScratch(scratchId, false);
      expect(f.removedServices).toEqual([]);
      expect(yield* prepared.stop).toBe(true);
      expect(f.removedVolumes).toEqual([]);
      expect(yield* prepared.destroy).toBe(true);
    }),
  );
  // Then the observations and volume generation are preserved across both phases.
  expect(f.removedServices).toEqual(f.services);
  expect(f.removedVolumes).toEqual([
    { ref: f.observedVolume.ref, generation: f.observedVolume.identity.generation },
  ]);
});

test("keep-volumes on a planless scratch removes only its containers", async () => {
  // Given labeled resources with no plan.
  const f = fixture();
  // When the reaper requests volume retention.
  await runScanner([f.provider], (scanner) =>
    Effect.gen(function* () {
      const prepared = yield* scanner.prepareScratch(scratchId, true);
      yield* prepared.stop;
      expect(yield* prepared.destroy).toBe(false);
    }),
  );
  // Then volume deletion is never requested.
  expect(f.removedServices).toEqual(f.services);
  expect(f.removedVolumes).toEqual([]);
});
