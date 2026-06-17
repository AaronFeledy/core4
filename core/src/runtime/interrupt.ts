/**
 * Signal handling — bridge `SIGINT` (and `SIGTERM` where appropriate) to
 * `Effect.interrupt` on the running fiber.
 *
 * The OCLIF entrypoint installs a signal handler that calls
 * `Effect.interrupt` on the running fiber. Providers' resource scopes
 * finalize automatically.
 *
 * Embedding hosts opt into this via `installSignalHandlers: true`. Off by
 * default in library mode so the host owns its own signal model.
 *
 */
import { Effect, type Fiber, type Scope } from "effect";

export interface InstallSignalHandlersOptions {
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown>;
  /**
   * Signals to handle. Defaults to the CLI signal set.
   */
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
}

export const installSignalHandlers = (
  options: InstallSignalHandlersOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const signals = Array.from(new Set(options.signals ?? ["SIGINT", "SIGTERM"]));
    const handlers = signals.map((signal) => {
      const handler = () => options.fiber.unsafeInterruptAsFork(options.fiber.id());
      process.once(signal, handler);
      return { signal, handler };
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const { signal, handler } of handlers) process.off(signal, handler);
      }),
    );
  });
