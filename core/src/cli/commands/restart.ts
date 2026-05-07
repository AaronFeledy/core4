/**
 * `lando restart` — `stop` + `start`.
 *
 * Bootstrap level: `app`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

// biome-ignore lint/suspicious/noEmptyInterface: fields land with implementation
export interface RestartAppOptions {
  // Reserved for future flags.
}

export interface RestartAppResult {
  readonly app: string;
}

export const restartApp = (
  _options?: RestartAppOptions,
): Effect.Effect<RestartAppResult, LandoCommandError, never> => {
  throw new Error("restartApp: not yet implemented");
};
