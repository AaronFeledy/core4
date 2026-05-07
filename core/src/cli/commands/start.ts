/**
 * `lando start` — start the current app.
 *
 * Bootstrap level: `app`.
 *
 * Programmatic equivalent: `startApp({ reconcile: false })` from
 * `@lando/core/cli`.
 */
import type { Effect } from "effect";

import type { LandoCommandError, ProviderUnavailableError } from "@lando/sdk/errors";

export interface StartAppOptions {
  readonly reconcile?: boolean;
}

export interface StartAppResult {
  readonly app: string;
  readonly servicesStarted: ReadonlyArray<string>;
}

/**
 * Start the app discovered at the runtime's `cwd`.
 *
 * Bootstrap level: `app`. Requires `LandofileService`, `AppPlanner`,
 * `RuntimeProviderRegistry`, `EventService`, `Logger`.
 *
 * TODO: implement.
 */
export const startApp = (
  _options?: StartAppOptions,
): Effect.Effect<StartAppResult, LandoCommandError | ProviderUnavailableError, never> => {
  throw new Error("startApp: not yet implemented");
};
