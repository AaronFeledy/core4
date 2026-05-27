/**
 * Provider selection precedence resolver.
 *
 * Precedence (highest first):
 *   1. `flag`           — CLI `--provider` argument
 *   2. `landofile`      — Landofile top-level `provider:` field
 *   3. `env`            — `LANDO_PROVIDER` environment variable
 *   4. `config`         — `defaultProviderId` from `~/.lando/config.yml`
 *                         (already merged with `LANDO_DEFAULT_PROVIDER_ID` env overlay
 *                         by `ConfigService`)
 *   5. `default`        — hard-coded capability-based default (`lando`)
 *
 * The resolver is a pure function so every (flag, landofile, env, config,
 * default) combination can be exercised in unit tests without spinning up the
 * runtime layer.
 */
import { ProviderId } from "@lando/sdk/schema";

export type ProviderSelectionSource = "flag" | "landofile" | "env" | "config" | "default";

export interface ProviderSelectionInputs {
  readonly flag?: ProviderId | undefined;
  readonly landofile?: ProviderId | undefined;
  readonly env?: ProviderId | undefined;
  readonly config?: ProviderId | undefined;
  readonly capabilityDefault: ProviderId;
}

export interface ProviderSelectionResolution {
  readonly providerId: ProviderId;
  readonly source: ProviderSelectionSource;
  readonly inputs: ProviderSelectionInputs;
}

/**
 * Hard-coded capability-based default. `provider-lando` ships bundled with
 * core and works on every supported host, so it is the safe fallback when no
 * other input is provided.
 */
export const CAPABILITY_DEFAULT_PROVIDER_ID: ProviderId = ProviderId.make("lando");

/**
 * Resolve the selected provider id from the given inputs, returning both the
 * resolved id and the source that supplied it. Inputs that are `undefined` are
 * ignored. `capabilityDefault` is always required.
 */
export const resolveProviderSelection = (inputs: ProviderSelectionInputs): ProviderSelectionResolution => {
  if (inputs.flag !== undefined) {
    return { providerId: inputs.flag, source: "flag", inputs };
  }
  if (inputs.landofile !== undefined) {
    return { providerId: inputs.landofile, source: "landofile", inputs };
  }
  if (inputs.env !== undefined) {
    return { providerId: inputs.env, source: "env", inputs };
  }
  if (inputs.config !== undefined) {
    return { providerId: inputs.config, source: "config", inputs };
  }
  return { providerId: inputs.capabilityDefault, source: "default", inputs };
};

/**
 * Read the `LANDO_PROVIDER` env var and brand it as a `ProviderId` if present.
 * Returns `undefined` for missing or empty values so it can be passed directly
 * into `resolveProviderSelection` as the `env` slot.
 */
export const readProviderEnvVar = (
  env: Readonly<Record<string, string | undefined>>,
): ProviderId | undefined => {
  const value = env.LANDO_PROVIDER;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return ProviderId.make(trimmed);
};
