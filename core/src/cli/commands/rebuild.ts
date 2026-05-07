/**
 * `lando rebuild` — rebuild the current app's artifacts and restart.
 *
 * Bootstrap level: `app`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

export interface RebuildAppOptions {
  readonly service?: string;
}

export interface RebuildAppResult {
  readonly app: string;
  readonly servicesRebuilt: ReadonlyArray<string>;
}

export const rebuildApp = (
  _options?: RebuildAppOptions,
): Effect.Effect<RebuildAppResult, LandoCommandError, never> => {
  throw new Error("rebuildApp: not yet implemented");
};
