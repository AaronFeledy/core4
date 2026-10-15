/**
 * Signal handling. Bridge SIGINT, SIGTERM, SIGHUP on POSIX, and SIGBREAK on
 * Windows, to `Effect.interrupt` on the running fiber.
 *
 * The native CLI dispatcher installs a signal handler that calls
 * `Effect.interrupt` on the running fiber. Providers' resource scopes
 * finalize automatically.
 *
 * Embedding hosts opt into this via `installSignalHandlers: true`. Off by
 * default in library mode so the host owns its own signal model.
 *
 */
import { Effect, type Fiber, type Scope } from "effect";

export interface InstallSignalHandlersOptions {
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  /**
   * Signals to handle. Defaults to the CLI signal set.
   */
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
}

export const defaultInterruptSignals = (
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<NodeJS.Signals> =>
  platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];

export const installSignalHandlers = Effect.fnUntraced(function* (
  options: InstallSignalHandlersOptions,
): Effect.fn.Return<void, never, Scope.Scope> {
  const signals = Array.from(new Set(options.signals ?? defaultInterruptSignals()));
  const interruptor = options.fiber.id;
  const handlers = signals.map((signal) => {
    const handler = () => {
      options.fiber.interruptUnsafe(interruptor);
    };
    (process as NodeJS.EventEmitter).once(signal, handler);
    return { signal, handler };
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const { signal, handler } of handlers) (process as NodeJS.EventEmitter).off(signal, handler);
    }),
  );
});
