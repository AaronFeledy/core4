/**
 * `@lando/core/testing` — embedding-host + core test fixtures.
 *
 * **Stability:** unstable on `stable` channel until v4.0.0 GA. Published
 * on `next` and `dev` channels for early adopters.
 *
 * Provided fixtures:
 *   - `TestRuntime` — a pre-composed `Layer` with in-memory `FileSystem`,
 *     in-memory `ProcessRunner`, mock `RuntimeProvider`, and a
 *     `TestEventService` bus that records all published events.
 *   - `TestRuntimeProvider` — a `RuntimeProvider` Layer that satisfies
 *     the contract suite without running any real provider.
 *   - `withLandofile(yamlOrObject)` — helper that injects a virtual
 *     Landofile into the in-memory `FileSystem`.
 *   - `expectEvent(name, predicate)` — awaits an event matching the
 *     predicate; fails the test with a useful diff if it doesn't arrive
 *     within a timeout.
 *   - `recordedEvents()` — returns the full event log captured during
 *     the test, for snapshot assertions.
 *   - `TestClock` / `TestRandom` — re-exports of Effect's testing
 *     primitives.
 *
 * Status: stub.
 */
import type { Effect, Layer } from "effect";

import type { LandoEvent } from "@lando/sdk/events";

/**
 * `TestRuntime` — pre-composed Layer satisfying every default service
 * tag with deterministic in-memory implementations.
 *
 * TODO: build the full TestRuntime Layer.
 */
export const TestRuntime: Layer.Layer<unknown, unknown, never> = (() => {
  throw new Error("TestRuntime: not yet implemented");
})();

/**
 * Inject a virtual Landofile into the test runtime's in-memory FileSystem.
 *
 * @example
 *   await Effect.runPromise(
 *     program.pipe(
 *       Effect.provide(withLandofile({ name: "demo", services: { app: {} } })),
 *       Effect.provide(TestRuntime),
 *       Effect.scoped,
 *     ),
 *   );
 */
export const withLandofile = (
  _yamlOrObject: string | Record<string, unknown>,
): Layer.Layer<unknown, unknown, never> => {
  throw new Error("withLandofile: not yet implemented");
};

/**
 * Await an event matching the predicate; fails the test with a useful diff
 * if it doesn't arrive within `timeout` ms.
 */
export const expectEvent = <E extends LandoEvent>(
  _name: E["_tag"],
  _predicate?: (event: E) => boolean,
  _timeout?: number,
): Effect.Effect<E, never, never> => {
  throw new Error("expectEvent: not yet implemented");
};

/**
 * Returns the full event log captured during the test.
 */
export const recordedEvents = (): Effect.Effect<ReadonlyArray<LandoEvent>, never, never> => {
  throw new Error("recordedEvents: not yet implemented");
};

// Re-export Effect's testing primitives for convenience.
// In current Effect, TestClock is its own module while randomness is
// plumbed via `TestServices` (which also covers TestClock, TestSized,
// TestConfig, TestAnnotations, etc.).
export * as TestClock from "effect/TestClock";
export * as TestServices from "effect/TestServices";
