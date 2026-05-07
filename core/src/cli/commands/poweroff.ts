/**
 * `lando poweroff` — stop every Lando-managed service across apps.
 *
 * Bootstrap level: `provider`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

// biome-ignore lint/suspicious/noEmptyInterface: fields land with implementation
export interface PoweroffOptions {
  // Reserved for future flags.
}

export interface PoweroffResult {
  readonly appsPoweredOff: ReadonlyArray<string>;
}

export const poweroff = (
  _options?: PoweroffOptions,
): Effect.Effect<PoweroffResult, LandoCommandError, never> => {
  throw new Error("poweroff: not yet implemented");
};
