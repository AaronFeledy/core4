/**
 * `lando config` — read or write Lando config.
 *
 * Bootstrap level: `plugins`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";

export interface ConfigOptions {
  /** When set, dumps only this key. */
  readonly key?: string;
}

export interface ConfigResult {
  readonly config: GlobalConfig;
}

export const config = (_options?: ConfigOptions): Effect.Effect<ConfigResult, LandoCommandError, never> => {
  throw new Error("config: not yet implemented");
};
