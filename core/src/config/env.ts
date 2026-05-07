/**
 * Environment-variable override decoding.
 *
 * - Keys are converted from `camelCase` to `UPPER_SNAKE_CASE`.
 * - JSON-parseable string values are parsed into objects/arrays.
 * - `LANDO_PLUGIN_CONFIG_<NAME>` injects plugin config (JSON).
 * - `LANDO_PROVIDER_<PROVIDER>_*` adjusts a single provider's extension config.
 *
 * Status: stub. Implementation lands with `ConfigServiceLive`.
 */
import type { Effect } from "effect";

import type { ConfigError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";

export interface EnvDecodeOptions {
  /** Prefix to honor (default `LANDO`, configurable via `envPrefix`). */
  readonly prefix: string;
  /** The current `process.env`-like record. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * TODO: decode `<prefix>_*` env vars into a partial `GlobalConfig`.
 * Returns the decoded partial; merge is the caller's responsibility.
 */
export const decodeEnvOverrides = (
  _options: EnvDecodeOptions,
): Effect.Effect<Partial<GlobalConfig>, ConfigError> => {
  throw new Error("decodeEnvOverrides: not yet implemented");
};
