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
 * Status: stub — wires up `process.on("SIGINT", ...)` against a `Fiber.Runtime`
 * passed in. Implementation lands with the OCLIF init hook.
 */
import type { Effect, Fiber } from "effect";

export interface InstallSignalHandlersOptions {
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown>;
  /**
   * Signals to handle. Defaults to `["SIGINT"]`. CLI installs both
   * `SIGINT` and `SIGTERM`; embedding hosts may want only `SIGINT`.
   */
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
}

/**
 * TODO: wire signal handlers to `Fiber.interrupt(fiber)`.
 * Returns a cleanup `Effect` that removes the listeners.
 */
export const installSignalHandlers = (
  _options: InstallSignalHandlersOptions,
): Effect.Effect<void, never, never> => {
  // Implementation lands with the OCLIF init hook.
  throw new Error("installSignalHandlers: not yet implemented");
};
