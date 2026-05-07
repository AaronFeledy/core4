/**
 * `lando stop` — stop the current app.
 *
 * Bootstrap level: `app`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

// biome-ignore lint/suspicious/noEmptyInterface: fields land with implementation
export interface StopAppOptions {
  // Reserved for future flags (e.g. --service to stop one service only).
}

export interface StopAppResult {
  readonly app: string;
  readonly servicesStopped: ReadonlyArray<string>;
}

export const stopApp = (
  _options?: StopAppOptions,
): Effect.Effect<StopAppResult, LandoCommandError, never> => {
  throw new Error("stopApp: not yet implemented");
};
