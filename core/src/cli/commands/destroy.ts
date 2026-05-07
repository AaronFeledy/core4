/**
 * `lando destroy` — destroy the current app.
 *
 * Requires confirmation unless `--yes` is passed. Bootstrap level: `app`.
 *
 * Removes everything `apply` created — including service-scope and app-scope
 * storage volumes. `global` scope volumes survive `destroy`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

export interface DestroyAppOptions {
  /** Skip the confirmation prompt. */
  readonly yes?: boolean;
}

export interface DestroyAppResult {
  readonly app: string;
}

export const destroyApp = (
  _options?: DestroyAppOptions,
): Effect.Effect<DestroyAppResult, LandoCommandError, never> => {
  throw new Error("destroyApp: not yet implemented");
};
