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

export const CAPABILITY_DEFAULT_PROVIDER_ID: ProviderId = ProviderId.make("lando");

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

export const readProviderEnvVar = (
  env: Readonly<Record<string, string | undefined>>,
): ProviderId | undefined => {
  const value = env.LANDO_PROVIDER;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return ProviderId.make(trimmed);
};
