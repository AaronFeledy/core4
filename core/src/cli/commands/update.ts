/**
 * `lando update` — check / apply updates to core and plugins.
 *
 * Release channels: `stable`, `next`, `dev`. Bootstrap level: `plugins`.
 *
 * The compiled binary self-updates by writing a new binary alongside,
 * atomic-renaming, and re-execing.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

export interface UpdateOptions {
  /** Update channel: `stable` (default), `next`, or `dev`. */
  readonly channel?: "stable" | "next" | "dev";
  /** Check only, don't apply. */
  readonly dryRun?: boolean;
}

export interface UpdateResult {
  readonly updatedCore: boolean;
  readonly updatedPlugins: ReadonlyArray<string>;
}

export const update = (_options?: UpdateOptions): Effect.Effect<UpdateResult, LandoCommandError, never> => {
  throw new Error("update: not yet implemented");
};
